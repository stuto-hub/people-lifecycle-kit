/** Shapes shared across the bot. Dates are always 'YYYY-MM-DD' strings. */
export type Flow = 'Joiner' | 'Leaver';
export type Row = Record<string, string>;

export interface Person {
  id: string; Name: string; Flow: Flow; Country: string; 'Worker type': string;
  'Day 0': string; Status: string; 'Added on': string; POC: string;
  'Lead (Slack ID)': string; 'Buddy (Slack ID)': string; 'Shared logins': string; Notes: string;
  /** The bot reads these legacy fields only in tests. */
  'Previous day 0'?: string; 'Day 0 changed on'?: string;
  _id?: string; _url?: string;
}

export interface Step {
  id: string; Step: string; Flow: Flow; 'Offset (days)': number; 'Owner role': string;
  Critical: boolean; 'Human moment': boolean; Confidential: boolean; 'Recheck if day 0 moves': boolean; 'Nudge text': string;
}

export interface StepStatus { Status: string; Notes?: string; 'Done on'?: string; 'N/A'?: boolean }

export interface Guide { Guide: string; Owner: string; 'Last reviewed': string; Link: string }
export interface Question { Question: string; Guide: string; Keywords: string; Answer: string; Action: string; Confidential: boolean }

export interface Data {
  people: Person[]; steps: Step[]; status: Record<string, StepStatus>; guides: Guide[]; questions: Question[];
  /** tracker/handbook.md: short fictional policy text the chat bot answers from */
  handbook?: string;
  /** true when read from the tracker CSVs: flow starts and date moves are then posted on change, not by the daily run */
  fromTracker?: boolean;
}

export interface Task {
  _id: string; _url: string; Person: string[]; Step: string; StepId: string; Due: string; Status: string; Notes: string;
  'Owner role': string; Critical: boolean; 'Human moment': boolean; Confidential: boolean;
  'Needs action': boolean; Health: string; 'Escalate to': string;
}

/** One Slack message planned by the bot. */
export interface Msg { to: string; kind: string; text: string; taskId?: string; url?: string; confidential?: boolean }

/** One change to the tracker: a cell edit, or a new row (columns = every column). */
export interface TrackerChange { tab: 'Joiners' | 'Leavers'; columns: string[]; oldValue: string; value: string; row: Row }
