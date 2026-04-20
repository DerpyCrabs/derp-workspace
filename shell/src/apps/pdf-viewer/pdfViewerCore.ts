export function isPdfFilePath(path: string): boolean {
  return /\.pdf$/i.test(path)
}
