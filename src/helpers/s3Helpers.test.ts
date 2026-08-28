import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

interface ListedBackup {
  key: string;
  lastModified?: Date;
}

interface ListResponse {
  contents?: ListedBackup[];
  isTruncated?: boolean;
  nextContinuationToken?: string;
}

const testEnvironment: {
  BACKUP_FILE_PREFIX: string;
  BACKUP_RETENTION_DAYS: number | undefined;
  BUCKET_SUBFOLDER: string | undefined;
} = {
  BACKUP_FILE_PREFIX: "backup",
  BACKUP_RETENTION_DAYS: 1,
  BUCKET_SUBFOLDER: undefined,
};

const listResponses: ListResponse[] = [];
const list = mock((): ListResponse => {
  const response = listResponses.shift();
  if (!response) {
    throw new Error("Missing mocked S3 list response.");
  }
  return response;
});
const deleteObject = mock<(key: string) => void>(() => {});
const write = mock<(name: string, file: Blob) => number>(() => 0);

const writerWrite = mock<(chunk: Uint8Array) => number>(
  (chunk) => chunk.byteLength,
);
const writerEnd = mock<() => Promise<number>>(async () => Promise.resolve(0));
const writer = mock(() => ({ write: writerWrite, end: writerEnd }));
const s3File = mock<(name: string) => { writer: typeof writer }>(() => ({
  writer,
}));

const loggerSuccess = mock<(message: string) => void>(() => {});

void mock.module("../env", () => ({ env: testEnvironment }));
void mock.module("../lib/s3", () => ({
  s3Client: {
    delete: deleteObject,
    file: s3File,
    list,
    write,
  },
}));
void mock.module("../utils/logger", () => ({
  logger: {
    break: mock(() => {}),
    error: mock(() => {}),
    info: mock(() => {}),
    success: loggerSuccess,
    warn: mock(() => {}),
  },
}));

const { deleteOldBackups } = await import("./deleteOldBackups");
const { uploadToS3 } = await import("./uploadToS3");

async function expectToReject(
  operation: () => Promise<unknown>,
  expectedMessage: string,
) {
  let thrownError: unknown;

  try {
    await operation();
  } catch (error) {
    thrownError = error;
  }

  expect(thrownError).toBeInstanceOf(Error);
  expect((thrownError as Error).message).toBe(expectedMessage);
}

beforeEach(() => {
  testEnvironment.BACKUP_FILE_PREFIX = "backup";
  testEnvironment.BACKUP_RETENTION_DAYS = 1;
  testEnvironment.BUCKET_SUBFOLDER = undefined;
  listResponses.length = 0;
  list.mockClear();
  deleteObject.mockClear();
  write.mockClear();
  s3File.mockClear();
  writer.mockClear();
  writerWrite.mockClear();
  writerEnd.mockClear();
  loggerSuccess.mockClear();
});

describe("deleteOldBackups", () => {
  test("skips S3 when retention is disabled", async () => {
    testEnvironment.BACKUP_RETENTION_DAYS = undefined;

    await deleteOldBackups();

    expect(list).not.toHaveBeenCalled();
  });

  test("paginates and deletes only expired backups", async () => {
    const now = Date.now();
    listResponses.push(
      {
        contents: [
          {
            key: "backup-old.tar.gz",
            lastModified: new Date(now - 2 * 24 * 60 * 60 * 1000),
          },
          {
            key: "backup-current.tar.gz",
            lastModified: new Date(now),
          },
        ],
        isTruncated: true,
        nextContinuationToken: "next-page",
      },
      {
        contents: [],
        isTruncated: false,
      },
    );

    await deleteOldBackups();

    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: "backup",
      continuationToken: undefined,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: "backup",
      continuationToken: "next-page",
    });
    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith("backup-old.tar.gz");
  });

  test("skips a backup without lastModified metadata", async () => {
    listResponses.push({
      contents: [{ key: "backup-without-date.tar.gz" }],
      isTruncated: false,
    });

    await deleteOldBackups();

    expect(deleteObject).not.toHaveBeenCalled();
  });

  test("rejects a truncated response without a continuation token", async () => {
    listResponses.push({ isTruncated: true });

    await expectToReject(
      deleteOldBackups,
      "S3 returned a truncated backup list without a valid continuation token.",
    );
  });

  test("rejects a repeated continuation token", async () => {
    listResponses.push(
      {
        isTruncated: true,
        nextContinuationToken: "same-token",
      },
      {
        isTruncated: true,
        nextContinuationToken: "same-token",
      },
    );

    await expectToReject(
      deleteOldBackups,
      "S3 returned a truncated backup list without a valid continuation token.",
    );
  });
});

const MULTIPART_THRESHOLD = 5 * 1024 * 1024;
const fixturesDirectory = join(tmpdir(), "postgres-s3-backups-tests");
const smallFilePath = join(fixturesDirectory, "small-backup.tar.gz");
const largeFilePath = join(fixturesDirectory, "large-backup.tar.gz");

describe("uploadToS3", () => {
  beforeAll(async () => {
    await Bun.write(smallFilePath, new Uint8Array(1024));
    await Bun.write(largeFilePath, new Uint8Array(MULTIPART_THRESHOLD + 1));
  });

  afterAll(async () => {
    await rm(fixturesDirectory, { force: true, recursive: true });
  });

  test("uploads to the bucket root when no subfolder is configured", async () => {
    await uploadToS3({
      name: "backup.tar.gz",
      filePath: smallFilePath,
    });

    expect(write.mock.calls[0]?.[0]).toBe("backup.tar.gz");
  });

  test("uploads a BunFile using the configured subfolder", async () => {
    testEnvironment.BUCKET_SUBFOLDER = "postgres";

    await uploadToS3({
      name: "backup.tar.gz",
      filePath: smallFilePath,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe("postgres/backup.tar.gz");
    expect(write.mock.calls[0]?.[1]).toBeInstanceOf(Blob);
  });

  test("propagates upload failures", async () => {
    write.mockImplementationOnce(() => {
      throw new Error("S3 unavailable");
    });

    await expectToReject(async () => {
      await uploadToS3({
        name: "backup.tar.gz",
        filePath: smallFilePath,
      });
    }, "S3 unavailable");
  });

  test("keeps small files on the single-request write path", async () => {
    await uploadToS3({
      name: "backup.tar.gz",
      filePath: smallFilePath,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(s3File).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  test("uses the explicit multipart writer for large files", async () => {
    await uploadToS3({
      name: "backup.tar.gz",
      filePath: largeFilePath,
    });

    expect(write).not.toHaveBeenCalled();
    expect(s3File).toHaveBeenCalledTimes(1);
    expect(s3File.mock.calls[0]?.[0]).toBe("backup.tar.gz");
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writerWrite).toHaveBeenCalled();
  });

  test("streams the whole large file and awaits writer.end()", async () => {
    await uploadToS3({
      name: "backup.tar.gz",
      filePath: largeFilePath,
    });

    const writtenBytes = writerWrite.mock.calls.reduce(
      (total, [chunk]) => total + chunk.byteLength,
      0,
    );

    expect(writtenBytes).toBe(MULTIPART_THRESHOLD + 1);
    expect(writerEnd).toHaveBeenCalledTimes(1);
  });

  test("applies the configured subfolder on the multipart path", async () => {
    testEnvironment.BUCKET_SUBFOLDER = "postgres";

    await uploadToS3({
      name: "backup.tar.gz",
      filePath: largeFilePath,
    });

    expect(s3File.mock.calls[0]?.[0]).toBe("postgres/backup.tar.gz");
    expect(write).not.toHaveBeenCalled();
  });

  test("propagates multipart writer failures without completing", async () => {
    writerEnd.mockImplementationOnce(async () => {
      await Promise.resolve();
      throw new Error("Multipart upload aborted");
    });

    await expectToReject(async () => {
      await uploadToS3({
        name: "backup.tar.gz",
        filePath: largeFilePath,
      });
    }, "Multipart upload aborted");

    expect(loggerSuccess).not.toHaveBeenCalled();
  });
});
