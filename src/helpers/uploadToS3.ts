import { env } from "../env";
import { s3Client } from "../lib/s3";
import { logger } from "../utils/logger";

interface UploadToS3Props {
  name: string;
  filePath: string;
}

export async function uploadToS3({ name, filePath }: UploadToS3Props) {
  logger.info("Uploading backup to S3...");

  if (env.BUCKET_SUBFOLDER) {
    name = `${env.BUCKET_SUBFOLDER}/${name}`;
  }

  const localFile = Bun.file(filePath);
  const largeDataChunks = localFile.size > 5 * 1024 * 1024; // 5MB
  if (largeDataChunks) {
    logger.info("Large file detected, using multipart upload...");

    const s3File = s3Client.file(name);
    const writer = s3File.writer();

    for await (const chunk of localFile.stream()) {
      void writer.write(chunk);
    }
    await writer.end();
  } else {
    await s3Client.write(name, localFile);
  }

  logger.success("Upload completed.");
}
