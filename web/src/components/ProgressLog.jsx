import { useEffect, useRef } from "react";

export default function ProgressLog({ lines }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="progress-log">
      {lines.map((line, i) => (
        <div key={i} className="progress-line">
          {line}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
