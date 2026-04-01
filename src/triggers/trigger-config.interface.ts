export interface CronTrigger {
  name: string;
  schedule: string;
  target: string;
  prompt: string;
  agent?: string;
  before?: string;
}

export interface TriggersFile {
  triggers: CronTrigger[];
}
