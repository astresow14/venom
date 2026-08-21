import React from "react";
import { format } from "date-fns";
import {
  Calendar as CalendarIcon,
  CheckSquare,
  Clock,
  ShieldAlert,
  AlertCircle,
} from "lucide-react";
import {
  PersonalAgendaItem,
  CommunityBriefingPageCalendarStatus,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { formatLocalDateOnly } from "@/lib/dateOnly";

interface AgendaSectionProps {
  agenda: PersonalAgendaItem[];
  calendarStatus: CommunityBriefingPageCalendarStatus;
}

export function AgendaSection({
  agenda,
  calendarStatus,
}: AgendaSectionProps) {
  return (
    <section className="surface border border-border/60 shadow-soft rounded-xl p-5 mb-8">
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="bg-foreground text-background px-3 py-1 font-medium rounded-full text-xs flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" />
            Personal
          </div>
          <h2 className="text-sm font-semibold text-foreground">
            Your agenda
          </h2>
        </div>
      </header>

      {calendarStatus === "not_connected" && (
        <div className="mb-6 p-4 border border-dashed border-border/60 rounded-lg bg-background/50 flex flex-col items-center justify-center text-center">
          <CalendarIcon className="w-8 h-8 text-muted-foreground mb-3 opacity-50" />
          <h3 className="font-semibold text-sm mb-1 text-foreground">
            Calendar not connected
          </h3>
          <p className="text-xs text-muted-foreground mb-4 max-w-[250px]">
            Link your external calendar to view upcoming meetings here.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="rounded-md text-sm font-medium"
          >
            Connect calendar
          </Button>
        </div>
      )}

      {calendarStatus === "unavailable" && (
        <div className="mb-6 p-3 border border-destructive/60 rounded-lg bg-destructive/10 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-xs text-destructive mb-1">
              Sync error
            </h3>
            <p className="text-xs text-destructive/80">
              We couldn't reach your calendar provider. Retrying shortly.
            </p>
          </div>
        </div>
      )}

      {agenda.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-xs text-muted-foreground">
            No items on your personal agenda.
          </p>
        </div>
      ) : (
        <ul className="space-y-4">
          {agenda.map((item) => (
            <li
              key={item.id}
              className="group flex flex-col p-4 border border-border/60 rounded-lg bg-background hover:border-border transition-colors"
            >
              <div className="flex items-start justify-between gap-4 mb-2">
                <div className="flex items-center gap-2">
                  {item.source === "calendar" ? (
                    <CalendarIcon className="w-4 h-4 text-foreground shrink-0" />
                  ) : (
                    <CheckSquare className="w-4 h-4 text-foreground shrink-0" />
                  )}
                  <span className="font-semibold text-sm text-foreground leading-snug">
                    {item.title}
                  </span>
                </div>
                {item.state === "in_progress" && (
                  <span className="shrink-0 bg-foreground text-background text-xs font-medium rounded-full px-2 py-0.5">
                    Active
                  </span>
                )}
              </div>

              <div className="flex items-center gap-4 text-xs text-muted-foreground mt-2">
                {item.startsAt && (
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3" />
                    <time dateTime={item.startsAt}>
                      {format(new Date(item.startsAt), "h:mm a")}
                    </time>
                  </div>
                )}
                {item.dueDate && (
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3 h-3" />
                    <time dateTime={item.dueDate}>
                      Due {formatLocalDateOnly(item.dueDate)}
                    </time>
                  </div>
                )}
                {item.projectName && (
                  <div className="flex items-center gap-1.5 ml-auto">
                    <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full" />
                    <span className="truncate max-w-[120px]">
                      {item.projectName}
                    </span>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
