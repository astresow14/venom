const CITATION_PREFIX = "[source:";
const CITATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/;
const CONTEXT_CITATION_PATTERN = /\[source:([A-Za-z0-9_-]{1,160})\]/g;

export function citationIdsInContext(context: string): Set<string> {
  return new Set(
    [...context.matchAll(CONTEXT_CITATION_PATTERN)].map((match) => match[1]),
  );
}

function longestCitationPrefixSuffix(value: string): number {
  const limit = Math.min(value.length, CITATION_PREFIX.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(CITATION_PREFIX.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

export function createCitationStreamFilter(allowedIds: Iterable<string>) {
  const allowed = new Set(
    [...allowedIds].filter((id) => CITATION_ID_PATTERN.test(id)),
  );
  let pending = "";

  const drain = (flush: boolean): string => {
    let output = "";

    while (pending) {
      const start = pending.indexOf(CITATION_PREFIX);
      if (start < 0) {
        if (flush) {
          output += pending;
          pending = "";
          break;
        }

        const retainedLength = longestCitationPrefixSuffix(pending);
        output += pending.slice(0, pending.length - retainedLength);
        pending = pending.slice(pending.length - retainedLength);
        break;
      }

      output += pending.slice(0, start);
      pending = pending.slice(start);
      const end = pending.indexOf("]");
      if (end < 0) {
        if (flush) {
          output += pending;
          pending = "";
        }
        break;
      }

      const citationId = pending.slice(CITATION_PREFIX.length, end);
      if (allowed.has(citationId)) {
        output += pending.slice(0, end + 1);
      }
      pending = pending.slice(end + 1);
    }

    return output;
  };

  return {
    push(content: string) {
      pending += content;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}