export type ReceiptPrecision = 'exact' | 'minute' | 'relative' | 'unknown';
export interface Receipt {
  at: number | null;
  precision: ReceiptPrecision;
  uncertaintyMs: number | null;
}
export interface Invitation {
  id: string;
  receipt: Receipt;
}
export interface Message {
  id: string;
  own: boolean;
  text: string;
  attachment: boolean;
  transportConfirmed?: boolean;
  receipt: Receipt;
}
export interface Thread {
  id: string;
  messages: Message[];
  supported: boolean;
}
export type Verification = 'confirmed' | 'uncertain';
export interface LinkedInPort {
  authenticated(): Promise<boolean>;
  invitations(): Promise<Invitation[]>;
  accept(id: string, beforeClick: () => void): Promise<void>;
  verifyAcceptance(id: string): Promise<Verification>;
  conversations(): Promise<string[]>;
  thread(id: string): Promise<Thread>;
  send(id: string, text: string, beforeClick: () => void): Promise<void>;
  verifySend(id: string, textHash: string, afterMessageId: string): Promise<Verification>;
  close(): Promise<void>;
}
export interface Reply {
  should_reply: boolean;
  reply: string;
  language: string;
  reason: string;
}
export interface ReplyGenerator {
  generate(messages: Message[], signal: AbortSignal): Promise<Reply>;
}
export interface Timing {
  receivedAt: number | null;
  lastReceivedAt: number | null;
  precision: ReceiptPrecision;
  uncertaintyMs: number | null;
  detectedAt: number;
}
export type ActionStatus = 'pending' | 'executing' | 'confirmed' | 'uncertain' | 'failed';
export interface Action extends Timing {
  id: string;
  kind: 'invitation' | 'reply';
  ref: string;
  key: string;
  incomingIds: string[];
  textHash: string | null;
  status: ActionStatus;
  handledAt: number | null;
  confirmedAt: number | null;
  generatedAt: number | null;
  llmMs: number | null;
  debounceMs: number;
  attempts: number;
}
