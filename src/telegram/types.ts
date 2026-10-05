export interface TelegramConfig {
  botToken: string;
  chatId: string; // The chat ID to send messages to (your user ID or a group ID)
  deepgramApiKey?: string; // Optional: transcribe incoming voice notes
  bridgePort?: number; // Optional: local HTTP bridge port (default 8765)
}
