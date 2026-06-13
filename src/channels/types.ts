/**
 * Channel-agnostic message and service types.
 * Every messaging platform (WeChat, Feishu, etc.) implements ChannelService.
 */

export interface IncomingMessage {
  /** Sender identifier on the channel (WeChat openid, Feishu open_id, etc.) */
  userId: string;
  /** Raw message text, trimmed by the channel adapter */
  text: string;
  /** Channel identifier for formatter dispatch and logging */
  channel: "wechat" | "feishu";
  /** Channel-native message object (for channel-specific callbacks like sendFile) */
  raw: unknown;
}

export interface ChannelService {
  /** Human-readable channel name */
  name: string;

  /** Start the channel (login, connect, begin polling / websocket). */
  start(): Promise<void>;

  /** Stop the channel gracefully. */
  stop(): void;

  /** Register a handler for incoming messages. */
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;

  /** Reply to a message with text. */
  reply(msg: IncomingMessage, text: string): Promise<void>;

  /** Show "typing..." indicator (no-op if unsupported). */
  sendTyping(userId: string): Promise<void>;

  /** Cancel "typing..." indicator (no-op if unsupported). */
  stopTyping(userId: string): Promise<void>;

  /** Send a file attachment to a user. */
  sendFile(userId: string, filePath: string, fileName?: string): Promise<void>;

  /** Send an image to a user. */
  sendImage(userId: string, filePath: string): Promise<void>;
}
