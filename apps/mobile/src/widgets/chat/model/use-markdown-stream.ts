import { useEffect, useRef } from "react";

import {
  getNextChunkIndex,
  STREAMING_INTERVAL_MS,
  sampleMarkdown,
  THINKING_DELAY_MS,
} from "./chat";

type StartMarkdownStreamOptions = {
  onStreamingStart: () => void;
  onChunk: (content: string) => void;
  onComplete: () => void;
};

export function useMarkdownStream() {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);

  const cancel = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    activeRef.current = false;
  };

  const start = ({ onStreamingStart, onChunk, onComplete }: StartMarkdownStreamOptions) => {
    if (activeRef.current) {
      return false;
    }

    activeRef.current = true;
    let currentIndex = 0;

    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      onStreamingStart();

      intervalRef.current = setInterval(() => {
        currentIndex = getNextChunkIndex(currentIndex, sampleMarkdown.length);
        onChunk(sampleMarkdown.slice(0, currentIndex));

        if (currentIndex === sampleMarkdown.length) {
          if (intervalRef.current !== null) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }

          activeRef.current = false;
          onComplete();
        }
      }, STREAMING_INTERVAL_MS);
    }, THINKING_DELAY_MS);

    return true;
  };

  useEffect(() => cancel, [cancel]);

  return { start, cancel };
}
