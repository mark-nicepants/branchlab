import { ListChecks } from "lucide-react";
import type { Todo } from "../lib/types";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { todoStatusBg } from "@/lib/status";
import { cn } from "@/lib/utils";

interface Props {
  todos: Todo[];
}

function countCompleted(todos: Todo[]): number {
  return todos.filter((t) => t.status === "completed").length;
}

export function TodoButton({ todos }: Props) {
  const total = todos.length;
  const completed = countCompleted(todos);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={total === 0}
          className="h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground disabled:opacity-40"
        >
          <ListChecks className="size-3.5" />
          <span className="tabular-nums">
            {completed}/{total}
          </span>
        </Button>
      </PopoverTrigger>
      {total > 0 && (
        <PopoverContent align="end" side="top" className="w-80 p-0">
          <div className="max-h-[60vh] overflow-auto p-3">
            <div className="mb-2 text-xs font-medium text-muted-foreground">
              Todos ({completed}/{total})
            </div>
            <ul className="space-y-1.5">
              {todos.map((todo, i) => (
                <li
                  key={i}
                  className={cn(
                    "flex items-start gap-2 rounded px-2 py-1.5 text-xs",
                    todo.status === "completed" && "text-muted-foreground line-through",
                    todo.status === "in_progress" && "bg-accent text-accent-foreground",
                    todo.status === "pending" && "text-foreground",
                    todo.status === "cancelled" && "text-destructive line-through",
                  )}
                >
                  <StatusDot status={todo.status} />
                  <span className="flex-1">{todo.content}</span>
                </li>
              ))}
            </ul>
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
}

function StatusDot({ status }: { status: string }) {
  return <span className={cn("mt-1 block size-1.5 shrink-0 rounded-full", todoStatusBg(status))} />;
}
