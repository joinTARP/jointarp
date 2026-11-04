import { useState, type ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

/** 游戏工具覆盖在聊天上；需要连续查阅的工具在首次打开后保留状态。 */
export function GameToolDialog({
  open,
  onOpenChange,
  title,
  description,
  headerActions,
  finalFocus,
  wide = false,
  preserveState = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description: string;
  headerActions?: ReactNode;
  finalFocus?: React.ComponentProps<typeof DialogContent>["finalFocus"];
  wide?: boolean;
  preserveState?: boolean;
  children: ReactNode;
}) {
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        finalFocus={finalFocus}
        keepMounted={preserveState && hasOpened}
        className={`flex h-[85dvh] flex-col gap-0 overflow-hidden p-0 ${wide ? "sm:max-w-6xl" : "sm:max-w-3xl"}`}
      >
        <DialogHeader
          className={`border-border/60 shrink-0 border-b px-6 pr-16 ${headerActions ? "flex-row! flex-wrap items-center gap-3! py-4" : "py-5"}`}
        >
          <DialogTitle className="min-w-0 truncate">{title}</DialogTitle>
          {headerActions}
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
