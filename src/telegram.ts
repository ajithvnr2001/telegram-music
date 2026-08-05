import { TG_API } from "./types";

const REQUEST_TIMEOUT_MS = 25000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface TgFileInfo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
  mime_type?: string;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number; type: string; username?: string; title?: string };
  from?: { id: number; first_name?: string; username?: string; is_bot?: boolean };
  date: number;
  text?: string;
  caption?: string;
  audio?: TgMedia;
  video?: TgMedia;
  document?: TgMedia & { file_name?: string; thumb?: unknown };
  video_note?: TgMedia;
  voice?: TgMedia & { mime_type?: string };
  animation?: TgMedia & { file_name?: string };
  photo?: unknown[];
  forward_origin?: {
    type?: string;
    chat?: { id?: number; title?: string; type?: string };
    message_id?: number;
    date?: number;
  };
}

export interface TgMedia {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  mime_type?: string;
  duration?: number;
  width?: number;
  height?: number;
  title?: string;
  performer?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
}

export class Telegram {
  private constructor(private readonly token: string) {}

  static of(token: string): Telegram {
    return new Telegram(token);
  }

  private async call<T>(
    method: string,
    body: Record<string, unknown> = {},
    retries = 4,
  ): Promise<T> {
    const url = `${TG_API}/bot${this.token}/${method}`;
    for (let attempt = 0; attempt < retries; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429) {
        const json = (await res.json().catch(() => ({}))) as {
          parameters?: { retry_after?: number };
        };
        const wait = Math.min(json.parameters?.retry_after ?? 2, 10);
        await sleep(wait * 1000);
        continue;
      }
      const json = (await res.json().catch(() => ({ ok: false }))) as {
        ok: boolean;
        result?: T;
        description?: string;
        parameters?: { retry_after?: number };
      };
      if (!json.ok) {
        const wait = json.parameters?.retry_after;
        if (wait && attempt < retries - 1) {
          await sleep(Math.min(wait, 10) * 1000);
          continue;
        }
        throw new Error(`Telegram ${method}: ${json.description ?? "unknown error"}`);
      }
      return json.result as T;
    }
    throw new Error(`Telegram ${method}: failed after retries`);
  }

  async sendMessage(
    chatId: string | number,
    text: string,
    opts: { parse_mode?: string; disable_web_page_preview?: boolean; reply_to_message_id?: number } = {},
  ): Promise<TgMessage> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: opts.parse_mode ?? "HTML",
      disable_web_page_preview: opts.disable_web_page_preview ?? true,
      reply_to_message_id: opts.reply_to_message_id,
    });
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
  ): Promise<TgMessage> {
    return this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    });
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<boolean> {
    return this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
  }

  async sendChatAction(chatId: string | number, action: string): Promise<boolean> {
    return this.call<boolean>("sendChatAction", { chat_id: chatId, action }).catch(() => false);
  }

  async sendAudio(
    chatId: string | number,
    fileId: string,
    opts: { title?: string; performer?: string; duration?: number; caption?: string } = {},
  ): Promise<TgMessage> {
    return this.call("sendAudio", {
      chat_id: chatId,
      audio: fileId,
      title: opts.title,
      performer: opts.performer,
      duration: opts.duration,
      caption: opts.caption,
    });
  }

  async sendVideo(
    chatId: string | number,
    fileId: string,
    opts: { duration?: number; width?: number; height?: number; caption?: string } = {},
  ): Promise<TgMessage> {
    return this.call("sendVideo", {
      chat_id: chatId,
      video: fileId,
      supports_streaming: true,
      duration: opts.duration,
      width: opts.width,
      height: opts.height,
      caption: opts.caption,
    });
  }

  async sendDocument(
    chatId: string | number,
    fileId: string,
    opts: { caption?: string } = {},
  ): Promise<TgMessage> {
    return this.call("sendDocument", {
      chat_id: chatId,
      document: fileId,
      caption: opts.caption,
    });
  }

  async uploadMultipart(method: string, formData: FormData, retries = 3): Promise<TgMessage> {
    const url = `${TG_API}/bot${this.token}/${method}`;
    for (let attempt = 0; attempt < retries; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        const j = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
        await sleep(Math.min(j.parameters?.retry_after ?? 2, 10) * 1000);
        continue;
      }
      const j = (await res.json().catch(() => ({ ok: false }))) as {
        ok: boolean;
        result?: TgMessage;
        description?: string;
      };
      if (!j.ok) {
        const wait = (j as { parameters?: { retry_after?: number } }).parameters?.retry_after;
        if (wait && attempt < retries - 1) {
          await sleep(Math.min(wait, 10) * 1000);
          continue;
        }
        throw new Error(`Telegram ${method}: ${j.description ?? "upload failed"}`);
      }
      return j.result as TgMessage;
    }
    throw new Error(`Telegram ${method}: failed after retries`);
  }

  async getFile(fileId: string): Promise<TgFileInfo> {
    return this.call("getFile", { file_id: fileId });
  }

  async setWebhook(url: string, secretToken: string): Promise<boolean> {
    return this.call<boolean>("setWebhook", {
      url,
      secret_token: secretToken,
      allowed_updates: ["message", "channel_post"],
      drop_pending_updates: true,
    });
  }

  async setMyCommands(): Promise<boolean> {
    return this.call("setMyCommands", {
      commands: [
        { command: "start", description: "Open the music player" },
        { command: "list", description: "Show song count and player link" },
        { command: "search", description: "Search songs: /search <query>" },
        { command: "delete", description: "Delete a song: /delete <id>" },
        { command: "stats", description: "Show library stats" },
        { command: "help", description: "How to use the bot" },
      ],
    });
  }

  async getMe(): Promise<{ id: number; username: string }> {
    return this.call("getMe");
  }

  async getFileDownloadUrl(fileId: string): Promise<string> {
    const info = await this.getFile(fileId);
    if (!info.file_path) throw new Error("Telegram has no file path for this file");
    return `${TG_API}/file/bot${this.token}/${info.file_path}`;
  }
}
