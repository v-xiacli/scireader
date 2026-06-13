declare module 'pdf-poppler' {
  export const convert: (file: string, opts: Record<string, unknown>) => Promise<unknown>;
}
