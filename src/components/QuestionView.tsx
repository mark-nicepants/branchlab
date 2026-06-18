import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { QuestionInfo } from "../lib/types";

interface Props {
  questions: QuestionInfo[];
  onSubmit: (answers: string[][]) => void;
  onCancel?: () => void;
  disabled?: boolean;
}

export function QuestionView({ questions, onSubmit, onCancel, disabled }: Props) {
  // answers[i] holds the selected option labels for questions[i].
  const [answers, setAnswers] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ""));

  function toggle(qIndex: number, label: string, multiple: boolean) {
    setAnswers((prev) =>
      prev.map((selected, i) => {
        if (i !== qIndex) return selected;
        if (multiple) {
          return selected.includes(label)
            ? selected.filter((l) => l !== label)
            : [...selected, label];
        }
        return selected.includes(label) ? [] : [label];
      }),
    );
  }

  function canSubmit(): boolean {
    return questions.every((q, i) => {
      const hasOption = answers[i].length > 0;
      const hasCustom = q.custom && custom[i].trim().length > 0;
      return hasOption || hasCustom;
    });
  }

  function submit() {
    const final = questions.map((q, i) => {
      const optionLabels = answers[i];
      if (q.custom) {
        const text = custom[i].trim();
        if (text) return [...optionLabels, text];
      }
      return optionLabels;
    });
    onSubmit(final);
  }

  return (
    <div className="flex w-full flex-col gap-4 rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
      {questions.map((q, qIndex) => (
        <div key={qIndex} className="flex flex-col gap-2">
          {q.header && <div className="font-medium text-foreground">{q.header}</div>}
          {q.question && <div className="text-muted-foreground">{q.question}</div>}
          <div className="flex flex-col gap-1.5">
            {q.options.map((opt) => {
              const selected = answers[qIndex].includes(opt.label);
              return (
                <button
                  key={opt.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => toggle(qIndex, opt.label, !!q.multiple)}
                  className={cn(
                    "flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border bg-background hover:bg-accent",
                    disabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <span className="font-medium">{opt.label}</span>
                  {opt.description && (
                    <span className="text-xs text-muted-foreground">{opt.description}</span>
                  )}
                </button>
              );
            })}
          </div>
          {q.custom && (
            <Textarea
              value={custom[qIndex]}
              onChange={(e) =>
                setCustom((prev) => prev.map((v, i) => (i === qIndex ? e.target.value : v)))
              }
              placeholder="Or type your own answer…"
              disabled={disabled}
              className="min-h-[60px] resize-none border-border bg-background"
            />
          )}
        </div>
      ))}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={disabled}>
            Cancel
          </Button>
        )}
        <Button size="sm" onClick={submit} disabled={disabled || !canSubmit()}>
          Submit
        </Button>
      </div>
    </div>
  );
}
