

export type DeliberationRosterVoice = {
  voiceId: string;
  name: string;
  tagline?: string;
  modelId?: string;
  modelName?: string;
};
export type DeliberationTakeState = {
  content: string;
  status: "streaming" | "ok" | "failed";
};

export type LocalDeliberation = {
  roster: DeliberationRosterVoice[];
  takes: Record<string, DeliberationTakeState>;
  stage: "voices" | "synthesis";
};

export type DebateTurnLive = {
  index: number;
  voiceId: string;
  name: string;
  modelId?: string;
  modelName?: string;
  content: string;
};

export type LocalDebate = {
  roster: DeliberationRosterVoice[];
  of: number;
  current: DebateTurnLive | null;
  failedNames: string[];
};
