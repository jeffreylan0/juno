/**
 * Screenshots in files under the app's data folder (src-tauri/src/store.rs).
 * Temporary chats' screenshots go to storage.session instead, which the app
 * keeps in memory only (lib/images.ts).
 */
import type { ImageStore, StoredImage } from '@/lib/images';
import type { Transport } from './transport';

export class FileImageStore implements ImageStore {
  constructor(private t: Transport) {}

  async put(image: StoredImage): Promise<void> {
    await this.t.invoke('image_put', { id: image.id, chatId: image.chatId, dataUrl: image.dataUrl });
  }

  async get(id: string): Promise<StoredImage | undefined> {
    return (await this.t.invoke<StoredImage | null>('image_get', { id })) ?? undefined;
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length) await this.t.invoke('image_delete', { ids });
  }

  async deleteForChat(chatId: string): Promise<void> {
    await this.t.invoke('image_delete_for_chat', { chatId });
  }

  async chatIds(): Promise<Set<string>> {
    return new Set(await this.t.invoke<string[]>('image_chat_ids'));
  }
}
