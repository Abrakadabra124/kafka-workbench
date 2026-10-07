export type Assessment = { prompt: string; options: string[] };
export type Lesson = {
  id: string;
  title: string;
  duration: number;
  level: string;
  objective: string;
  theory: { title: string; body: string }[];
  takeaways: string[];
  question: Assessment;
  scenario: Assessment;
  sources: { title: string; url: string }[];
};
export type Module = {
  id: string;
  title: string;
  description: string;
  icon: string;
  lessons: Lesson[];
};
export type Answer = { correct: boolean; attempts: number; mastered?: boolean };
export type Progress = {
  completed: string[];
  answers: Record<string, { question?: Answer; scenario?: Answer }>;
  notes: Record<string, string>;
};
export const emptyProgress: Progress = { completed: [], answers: {}, notes: {} };
