import { useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Camera, Upload, Loader2, Video, X, Film } from "lucide-react";
import { uploadToCloudinary } from "@/lib/cloudinaryUpload";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";

interface MediaUploaderProps {
  onUploadComplete: (mediaUrl: string, mediaType: "image" | "video", thumbnailUrl?: string) => void;
  maxImageSize?: number;
  maxVideoSize?: number;
  maxVideoDuration?: number;
  buttonClassName?: string;
  buttonVariant?: "default" | "outline" | "ghost" | "secondary";
  buttonSize?: "default" | "sm" | "lg" | "icon";
  children?: ReactNode;
  allowVideo?: boolean;
  allowImage?: boolean;
}

export function MediaUploader({
  onUploadComplete,
  maxImageSize = 10485760,
  maxVideoSize = 52428800,
  maxVideoDuration = 15,
  buttonClassName,
  buttonVariant = "outline",
  buttonSize = "default",
  children,
  allowVideo = true,
  allowImage = true,
}: MediaUploaderProps) {
  const [showModal, setShowModal] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"image" | "video">("image");
  const [error, setError] = useState<string | null>(null);
  const [mediaMode, setMediaMode] = useState<"image" | "video">(allowImage ? "image" : "video");
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const selectedFileRef = useRef<File | null>(null);

  const resetState = () => {
    setPreview(null);
    setPreviewType("image");
    setError(null);
    setVideoDuration(null);
    setUploadProgress(0);
    selectedFileRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");

    if (!isVideo && !isImage) {
      setError("Please select an image or video file");
      return;
    }

    if (isImage && file.size > maxImageSize) {
      setError(`Image too large. Maximum size is ${Math.round(maxImageSize / 1024 / 1024)}MB`);
      return;
    }

    if (isVideo && file.size > maxVideoSize) {
      setError(`Video too large. Maximum size is ${Math.round(maxVideoSize / 1024 / 1024)}MB`);
      return;
    }

    setError(null);
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    setPreviewType(isVideo ? "video" : "image");

    selectedFileRef.current = file;
    
    if (isVideo) {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.onloadedmetadata = () => {
        window.URL.revokeObjectURL(video.src);
        const duration = video.duration;
        setVideoDuration(duration);
        
        if (duration > maxVideoDuration) {
          setError(`Video too long. Maximum duration is ${maxVideoDuration} seconds. Your video is ${Math.round(duration)} seconds.`);
          URL.revokeObjectURL(objectUrl);
          setPreview(null);
          selectedFileRef.current = null;
          return;
        }
        
        uploadFile(file, objectUrl, "video");
      };
      video.src = objectUrl;
    } else {
      uploadFile(file, objectUrl, "image");
    }
  }, [maxImageSize, maxVideoSize, maxVideoDuration]);

  const uploadFile = async (file: File, objectUrl: string, type: "image" | "video") => {
    setIsUploading(true);
    setUploadProgress(0);

    try {
      const result = await uploadToCloudinary(file, (progress) => {
        setUploadProgress(progress.percent);
      });

      URL.revokeObjectURL(objectUrl);
      onUploadComplete(result.url, result.type, result.thumbnailUrl);
      setShowModal(false);
      resetState();
    } catch (err) {
      console.error("Upload error:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to upload. Please try again.";
      setError(errorMessage);
      URL.revokeObjectURL(objectUrl);
      setPreview(null);
    } finally {
      setIsUploading(false);
    }
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const getAcceptType = () => {
    if (mediaMode === "video") return "video/mp4,video/webm,video/quicktime";
    return "image/*";
  };

  const handleCloseModal = () => {
    setShowModal(false);
    resetState();
  };

  return (
    <>
      <Button 
        type="button"
        onClick={() => setShowModal(true)} 
        className={buttonClassName}
        variant={buttonVariant}
        size={buttonSize}
        data-testid="button-upload-media"
      >
        {children || (
          <>
            <Camera className="h-4 w-4 mr-2" />
            {allowVideo ? "Upload Media" : "Upload Image"}
          </>
        )}
      </Button>

      <Dialog open={showModal} onOpenChange={handleCloseModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {allowImage && allowVideo ? "Upload Media" : allowVideo ? "Upload Video" : "Upload Image"}
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            {allowImage && allowVideo && (
              <Tabs value={mediaMode} onValueChange={(v) => { setMediaMode(v as "image" | "video"); resetState(); }}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="image" className="flex items-center gap-2" data-testid="tab-image">
                    <Camera className="h-4 w-4" />
                    Photo
                  </TabsTrigger>
                  <TabsTrigger value="video" className="flex items-center gap-2" data-testid="tab-video">
                    <Video className="h-4 w-4" />
                    Video
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept={getAcceptType()}
              onChange={handleFileSelect}
              className="hidden"
              data-testid="input-file-upload"
            />

            {preview ? (
              <div className="relative">
                {previewType === "video" ? (
                  <video
                    ref={videoRef}
                    src={preview}
                    className="w-full h-48 object-cover rounded-lg"
                    controls
                    muted
                    data-testid="video-preview"
                  />
                ) : (
                  <img
                    src={preview}
                    alt="Preview"
                    className="w-full h-48 object-cover rounded-lg"
                    data-testid="image-preview"
                  />
                )}
                {isUploading && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg">
                    <div className="text-center w-3/4">
                      <Loader2 className="h-8 w-8 animate-spin text-white mx-auto" />
                      <p className="text-white text-sm mt-2">Uploading... {uploadProgress}%</p>
                      <Progress value={uploadProgress} className="mt-2 h-2" />
                    </div>
                  </div>
                )}
                {!isUploading && (
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="absolute top-2 right-2"
                    onClick={resetState}
                    data-testid="button-remove-preview"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
                {videoDuration && previewType === "video" && (
                  <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                    {Math.round(videoDuration)}s
                  </div>
                )}
              </div>
            ) : (
              <div
                onClick={openFilePicker}
                className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center cursor-pointer hover-elevate"
                data-testid="upload-drop-zone"
              >
                {mediaMode === "video" ? (
                  <>
                    <Film className="h-10 w-10 mx-auto mb-4 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Click to select a video
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Max {maxVideoDuration}s, up to {Math.round(maxVideoSize / 1024 / 1024)}MB
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      MP4, WebM, or MOV formats
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="h-10 w-10 mx-auto mb-4 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      Click to select an image
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Take a photo, choose from camera roll, or select a file
                    </p>
                  </>
                )}
              </div>
            )}

            {error && (
              <div className="bg-destructive/10 text-destructive text-sm p-3 rounded-lg" data-testid="upload-error">
                {error}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
