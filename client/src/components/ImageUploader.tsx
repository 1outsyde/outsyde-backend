import { useState, useCallback, useRef } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Camera, Upload, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ImageUploaderProps {
  onUploadComplete: (imageUrl: string) => void;
  maxFileSize?: number;
  buttonClassName?: string;
  buttonVariant?: "default" | "outline" | "ghost" | "secondary";
  buttonSize?: "default" | "sm" | "lg" | "icon";
  children?: ReactNode;
  accept?: string;
}

export function ImageUploader({
  onUploadComplete,
  maxFileSize = 10485760,
  buttonClassName,
  buttonVariant = "outline",
  buttonSize = "default",
  children,
  accept = "image/*",
}: ImageUploaderProps) {
  const [showModal, setShowModal] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > maxFileSize) {
      setError(`File too large. Maximum size is ${Math.round(maxFileSize / 1024 / 1024)}MB`);
      return;
    }

    setError(null);
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    setIsUploading(true);

    try {
      const uploadResponse = await apiRequest("POST", "/api/objects/upload");
      const { uploadURL } = await uploadResponse.json();

      const putResponse = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        },
      });

      if (!putResponse.ok) {
        throw new Error(`Upload failed with status ${putResponse.status}`);
      }

      const finalizeResponse = await apiRequest("POST", "/api/objects/finalize", {
        uploadURL,
      });
      const { objectPath } = await finalizeResponse.json();

      URL.revokeObjectURL(objectUrl);
      onUploadComplete(objectPath);
      setShowModal(false);
      setPreview(null);
    } catch (err) {
      console.error("Upload error:", err);
      setError("Failed to upload image. Please try again.");
      URL.revokeObjectURL(objectUrl);
      setPreview(null);
    } finally {
      setIsUploading(false);
    }
  }, [maxFileSize, onUploadComplete]);

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  return (
    <>
      <Button 
        type="button"
        onClick={() => setShowModal(true)} 
        className={buttonClassName}
        variant={buttonVariant}
        size={buttonSize}
        data-testid="button-upload-image"
      >
        {children || (
          <>
            <Camera className="h-4 w-4 mr-2" />
            Upload Image
          </>
        )}
      </Button>

      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload Image</DialogTitle>
          </DialogHeader>
          
          <div className="space-y-4">
            <input
              ref={fileInputRef}
              type="file"
              accept={accept}
              onChange={handleFileSelect}
              className="hidden"
              data-testid="input-file-upload"
            />

            {preview ? (
              <div className="relative">
                <img
                  src={preview}
                  alt="Preview"
                  className="w-full h-48 object-cover rounded-lg"
                />
                {isUploading && (
                  <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg">
                    <Loader2 className="h-8 w-8 animate-spin text-white" />
                  </div>
                )}
              </div>
            ) : (
              <div
                onClick={openFilePicker}
                className="border-2 border-dashed border-muted-foreground/25 rounded-lg p-8 text-center cursor-pointer hover-elevate"
                data-testid="upload-drop-zone"
              >
                <Upload className="h-10 w-10 mx-auto mb-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Click to select an image
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  Take a photo, choose from camera roll, or select a file
                </p>
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive" data-testid="upload-error">{error}</p>
            )}

            <div className="flex gap-2">
              <Button
                type="button"
                onClick={openFilePicker}
                disabled={isUploading}
                className="flex-1"
                data-testid="button-choose-file"
              >
                {isUploading ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Uploading...
                  </>
                ) : (
                  <>
                    <Camera className="h-4 w-4 mr-2" />
                    Choose Image
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowModal(false);
                  setPreview(null);
                  setError(null);
                }}
                disabled={isUploading}
                data-testid="button-cancel-upload"
              >
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
