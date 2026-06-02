interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

/**
 * Upload an image to R2 via our server endpoint, or upload a video directly
 * to Mux using a server-issued upload URL.
 *
 * For images the server receives the file, stores it in Cloudflare R2, and
 * returns the public CDN URL.
 *
 * For videos the server issues a Mux direct-upload URL.  The file is PUT
 * straight from the browser to Mux.  The returned `url` field contains the
 * Mux uploadId, which the backend's Mux webhook handler uses to update the
 * post record with the real streaming URL once Mux finishes processing.
 */
export async function uploadToCloudinary(
  file: File,
  onProgress?: (progress: UploadProgress) => void
): Promise<{
  url: string;
  type: "image" | "video";
  thumbnailUrl?: string;
  width: number;
  height: number;
  duration?: number;
}> {
  const isVideo = file.type.startsWith("video/");

  if (isVideo) {
    return uploadVideoViaMux(file, onProgress);
  } else {
    return uploadImageToR2(file, onProgress);
  }
}

async function uploadImageToR2(
  file: File,
  onProgress?: (progress: UploadProgress) => void
): Promise<{
  url: string;
  type: "image";
  thumbnailUrl?: string;
  width: number;
  height: number;
}> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("folder", "posts");

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          percent: Math.round((event.loaded / event.total) * 100),
        });
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText);
          resolve({
            url: result.url,
            type: "image",
            thumbnailUrl: undefined,
            width: result.width || 0,
            height: result.height || 0,
          });
        } catch {
          reject(new Error("Failed to parse upload response"));
        }
      } else {
        let errorMessage = "Upload failed";
        try {
          const errorData = JSON.parse(xhr.responseText);
          errorMessage = errorData.error || errorMessage;
        } catch {
          // ignore parse error
        }
        reject(new Error(errorMessage));
      }
    });

    xhr.addEventListener("error", () => {
      reject(new Error("Network error during upload"));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Upload was cancelled"));
    });

    xhr.open("POST", "/api/media/upload-image");
    xhr.withCredentials = true;
    xhr.send(formData);
  });
}

async function uploadVideoViaMux(
  file: File,
  onProgress?: (progress: UploadProgress) => void
): Promise<{
  url: string;
  type: "video";
  thumbnailUrl?: string;
  width: number;
  height: number;
  duration?: number;
}> {
  // Step 1: Get a Mux direct-upload URL from our server
  const response = await fetch("/api/media/video-upload-url", {
    method: "POST",
    credentials: "include",
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Failed to get video upload URL");
  }

  const { uploadUrl, uploadId } = await response.json();

  // Step 2: PUT the file directly to Mux
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          percent: Math.round((event.loaded / event.total) * 100),
        });
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Video upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () =>
      reject(new Error("Network error during video upload"))
    );
    xhr.addEventListener("abort", () =>
      reject(new Error("Video upload was cancelled"))
    );

    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.send(file);
  });

  // The real streaming URL is populated asynchronously by the Mux webhook.
  // We return the uploadId as a temporary URL so the post can be created
  // and updated later by the webhook handler.
  return {
    url: uploadId,
    type: "video",
    thumbnailUrl: undefined,
    width: 0,
    height: 0,
  };
}
