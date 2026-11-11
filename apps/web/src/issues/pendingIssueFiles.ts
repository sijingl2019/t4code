import { create } from "zustand";

/**
 * Hands ONES issue attachments to the composer of a freshly created draft thread. The composer
 * owns attachment validation/compression, so the picker only parks the files by thread id.
 */
interface PendingIssueFilesState {
  readonly byThreadId: Readonly<Record<string, readonly File[]>>;
  readonly put: (threadId: string, files: readonly File[]) => void;
  readonly take: (threadId: string) => readonly File[] | undefined;
}

export const usePendingIssueFiles = create<PendingIssueFilesState>((set, get) => ({
  byThreadId: {},
  put: (threadId, files) =>
    set((state) => ({ byThreadId: { ...state.byThreadId, [threadId]: files } })),
  take: (threadId) => {
    const files = get().byThreadId[threadId];
    if (files === undefined) return undefined;
    set((state) => {
      const { [threadId]: _taken, ...rest } = state.byThreadId;
      return { byThreadId: rest };
    });
    return files;
  },
}));

export function base64ToFile(name: string, mimeType: string, dataBase64: string): File {
  const bytes = Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0));
  return new File([bytes], name, { type: mimeType });
}
