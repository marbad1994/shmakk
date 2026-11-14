import { Code2, MessageCircle, Palette, Workflow } from 'lucide-react';
import type { Mode } from './types';

export interface ModeInfo {
  id: Mode; label: string; icon: React.ReactNode; newLabel: string; tagline: string;
  placeholder: string; tone: string; // tailwind text colour class
}

/** The four spaces of the app. Each has its own chats, tools and feel. */
export const MODES: ModeInfo[] = [
  { id: 'chat', label: 'Chat', icon: <MessageCircle />, newLabel: 'New chat', tagline: 'Think, ask, write — a plain conversation', placeholder: 'Ask anything', tone: 'text-info' },
  { id: 'code', label: 'Code', icon: <Code2 />, newLabel: 'New session', tagline: 'An agent that reads, edits and runs in your workspace', placeholder: 'Ask shmakk anything — / for commands', tone: 'text-accent' },
  { id: 'design', label: 'Design', icon: <Palette />, newLabel: 'New design', tagline: 'Describe an interface and watch it take shape', placeholder: 'Describe what to design', tone: 'text-violet' },
  { id: 'cowork', label: 'Cowork', icon: <Workflow />, newLabel: 'New task', tagline: 'Hand off work — once, on a schedule, or on a trigger', placeholder: 'What should I take care of?', tone: 'text-warn' },
];

export const modeInfo = (m: Mode | undefined) => MODES.find((x) => x.id === m) ?? MODES[1];

export const PROJECT_COLORS: Record<string, string> = {
  green: 'bg-accent', blue: 'bg-info', violet: 'bg-violet', amber: 'bg-warn', rose: 'bg-danger',
};
