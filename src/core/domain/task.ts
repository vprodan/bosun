import type { InputPrivacy } from './inference.ts';
import type { Lane } from './route.ts';

export type Access = 'read' | 'edit';
export type Role = { id: string; instructions: string; access: Access; model?: string; effort?: string };
export type WorkspaceRef = { id: string; path: string; branch: string };
export type Task = { id: string; prompt: string; privacy: InputPrivacy; cwd: string; access: Access; role?: Role; lane?: Lane };
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type Job = { id: string; taskId: string; runnerId: string; state: JobState };
export type Review = { taskId: string; base: string; diff: string; untracked: string[]; runnerId: string; findings?: string };
