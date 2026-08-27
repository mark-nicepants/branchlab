// The canonical visual identity of a task: the board glyph + its number.
// Reused anywhere a task is referenced (cards, session header) so relations
// read the same across the app.
import { ListTodo } from "lucide-react";
import { cn } from "@/lib/utils";

export function TaskRef({
  number,
  className,
}: {
  number: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-[10px] text-muted-foreground",
        className,
      )}
    >
      <ListTodo className="size-3" />#{number}
    </span>
  );
}
