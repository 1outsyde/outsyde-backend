const CLOUDINARY_CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || 'doraffjvp';
const CLOUDINARY_UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || 'outsyde_unsigned';

interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  resource_type: 'image' | 'video';
  format: string;
  width: number;
  height: number;
  duration?: number;
  thumbnail_url?: string;
}

interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export async function uploadToCloudinary(
  file: File,
  onProgress?: (progress: UploadProgress) => void
): Promise<{
  url: string;
  type: 'image' | 'video';
  thumbnailUrl?: string;
  width: number;
  height: number;
  duration?: number;
}> {
  const isVideo = file.type.startsWith('video/');
  const resourceType = isVideo ? 'video' : 'image';
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  formData.append('resource_type', resourceType);
  
  const uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`;
  
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress({
          loaded: event.loaded,
          total: event.total,
          percent: Math.round((event.loaded / event.total) * 100),
        });
      }
    });
    
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result: CloudinaryUploadResult = JSON.parse(xhr.responseText);
          
          let thumbnailUrl: string | undefined;
          if (isVideo && result.public_id) {
            thumbnailUrl = `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/so_0/${result.public_id}.jpg`;
          }
          
          resolve({
            url: result.secure_url,
            type: isVideo ? 'video' : 'image',
            thumbnailUrl,
            width: result.width,
            height: result.height,
            duration: result.duration,
          });
        } catch (e) {
          reject(new Error('Failed to parse Cloudinary response'));
        }
      } else {
        let errorMessage = 'Upload failed';
        try {
          const errorData = JSON.parse(xhr.responseText);
          errorMessage = errorData.error?.message || errorMessage;
        } catch {
          // ignore parse error
        }
        reject(new Error(errorMessage));
      }
    });
    
    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'));
    });
    
    xhr.addEventListener('abort', () => {
      reject(new Error('Upload was cancelled'));
    });
    
    xhr.open('POST', uploadUrl);
    xhr.send(formData);
  });
}
