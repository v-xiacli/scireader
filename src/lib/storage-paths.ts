type User = {
  id?: string | null;
  name?: string | null;
} | null | undefined;

const sanitizeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');

export const getUserStoragePrefix = (user: User): string => {
  if (user?.id && user.name) {
    return `user-uploads/${user.id}-${sanitizeName(user.name)}/`;
  }

  return 'tmp/';
};
