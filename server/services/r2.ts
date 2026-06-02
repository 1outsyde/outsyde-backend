import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";

const r2Client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const BUCKET = process.env.R2_BUCKET_NAME || "outsyde-media";

export async function uploadImageToR2(
  fileBuffer: Buffer,
  mimeType: string,
  folder: string
): Promise<string> {
  const ext = mimeType.split("/")[1] || "jpg";
  const key = `${folder}/${uuidv4()}.${ext}`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: mimeType,
    })
  );

  const accountId = process.env.R2_ACCOUNT_ID;
  return `https://${accountId}.r2.cloudflarestorage.com/${BUCKET}/${key}`;
}

export async function deleteFromR2(url: string): Promise<void> {
  try {
    const key = url.split(`${BUCKET}/`)[1];
    if (!key) return;
    await r2Client.send(
      new DeleteObjectCommand({ Bucket: BUCKET, Key: key })
    );
  } catch (err) {
    console.error("[R2] Delete failed:", err);
  }
}
