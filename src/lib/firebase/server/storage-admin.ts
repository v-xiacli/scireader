import { BlobSASPermissions, BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters } from '@azure/storage-blob';

const appBaseEnvKeys = ['NEXT_PUBLIC_APP_BASE_URL', 'APP_BASE_URL'];

const resolveAppBaseUrl = () => {
  for (const key of appBaseEnvKeys) {
    const value = process.env[key];
    const trimmed = value?.trim().replace(/\/$/, '');

    if (!trimmed) continue;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    return `https://${trimmed}`;
  }

  return '';
};

const normalizeBlobPath = (filePath: string) => {
  const normalized = filePath.replace(/^\/+/, '').split('/').filter(Boolean).join('/');

  if (!normalized || normalized.split('/').includes('..')) {
    throw new Error('Invalid file path provided.');
  }

  return normalized;
};

const encodeStoragePath = (filePath: string) =>
  normalizeBlobPath(filePath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

const getContainerClient = () => {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
  const containerName = process.env.AZURE_STORAGE_CONTAINER?.trim();

  if (!connectionString || !containerName) {
    throw new Error('Missing Azure Blob Storage configuration. Add AZURE_STORAGE_CONNECTION_STRING and AZURE_STORAGE_CONTAINER to the environment.');
  }

  return BlobServiceClient.fromConnectionString(connectionString).getContainerClient(containerName);
};

const getBlockBlobClient = (filePath: string) => getContainerClient().getBlockBlobClient(normalizeBlobPath(filePath));

const parseConnectionString = () => {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
  if (!connectionString) return null;

  const parts = Object.fromEntries(
    connectionString
      .split(';')
      .map((part) => part.split('='))
      .filter((part): part is [string, string] => Boolean(part[0] && part[1])),
  );

  if (!parts.AccountName || !parts.AccountKey) return null;

  return {
    accountName: parts.AccountName,
    accountKey: parts.AccountKey,
  };
};

export const buildProxyDownloadUrl = (filePath: string) => {
  const relative = `/api/storage/download/${encodeStoragePath(filePath)}`;
  const base = resolveAppBaseUrl();

  return base ? `${base}${relative}` : relative;
};

export const uploadFileAsAdmin = async (buffer: Buffer, filePath: string, contentType: string) => {
  const blobClient = getBlockBlobClient(filePath);

  await blobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
};

export const uploadTextAsAdmin = async (content: string, filePath: string) => {
  await uploadFileAsAdmin(Buffer.from(content, 'utf8'), filePath, 'text/markdown; charset=utf-8');
};

export const generateSignedUrl = async (filePath: string, durationInMinutes = 15) => {
  const parsedConnectionString = parseConnectionString();
  const containerName = process.env.AZURE_STORAGE_CONTAINER?.trim();

  if (!parsedConnectionString || !containerName) return buildProxyDownloadUrl(filePath);

  const blobName = normalizeBlobPath(filePath);
  const credential = new StorageSharedKeyCredential(parsedConnectionString.accountName, parsedConnectionString.accountKey);
  const startsOn = new Date(Date.now() - 60_000);
  const expiresOn = new Date(Date.now() + durationInMinutes * 60_000);
  const sas = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
    },
    credential,
  ).toString();

  return `${getBlockBlobClient(filePath).url}?${sas}`;
};

export const downloadFileAsAdmin = async (filePath: string): Promise<{ buffer: Buffer; contentType: string }> => {
  const blobClient = getBlockBlobClient(filePath);
  const response = await blobClient.downloadToBuffer();
  const properties = await blobClient.getProperties();

  return {
    buffer: Buffer.from(response),
    contentType: properties.contentType || 'application/octet-stream',
  };
};

export const downloadTextAsAdmin = async (filePath: string) => {
  const { buffer } = await downloadFileAsAdmin(filePath);

  return buffer.toString('utf8');
};

export const deleteFileAsAdmin = async (filePath: string) => {
  await getBlockBlobClient(filePath).deleteIfExists();
};
