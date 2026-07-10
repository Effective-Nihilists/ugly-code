import React from 'react';

// Small lucide-style line icons for the workspace nav (session tab picker +
// sidebar prod views). 14px, stroke=currentColor so they inherit the button color.

function Svg({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const DeployIcon = (): React.ReactElement => (
  <Svg><path d="M4 12a8 8 0 0 1 16 0" /><circle cx={12} cy={12} r={1.5} fill="currentColor" /></Svg>
);
export const DatabaseIcon = (): React.ReactElement => (
  <Svg><ellipse cx={12} cy={5} rx={8} ry={3} /><path d="M4 5v6a8 3 0 0 0 16 0V5" /><path d="M4 11v6a8 3 0 0 0 16 0v-6" /></Svg>
);
export const ErrorsIcon = (): React.ReactElement => (
  <Svg><circle cx={12} cy={12} r={9} /><line x1={12} y1={8} x2={12} y2={13} /><line x1={12} y1={16} x2={12} y2={16} /></Svg>
);
export const EventsIcon = (): React.ReactElement => (
  <Svg><path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" /></Svg>
);
export const WorkersIcon = (): React.ReactElement => (
  <Svg><circle cx={12} cy={12} r={3} /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></Svg>
);
export const TerminalIcon = (): React.ReactElement => (
  <Svg><polyline points="5 8 9 12 5 16" /><line x1={12} y1={17} x2={19} y2={17} /></Svg>
);
export const GitIcon = (): React.ReactElement => (
  <Svg><circle cx={6} cy={6} r={2} /><circle cx={6} cy={18} r={2} /><circle cx={18} cy={12} r={2} /><path d="M6 8v8" /><path d="M6 12h6a4 4 0 0 0 4-4V8" /></Svg>
);
export const PreviewIcon = (): React.ReactElement => (
  <Svg><rect x={2} y={4} width={20} height={16} rx={2} /><line x1={2} y1={9} x2={22} y2={9} /></Svg>
);
export const FileIcon = (): React.ReactElement => (
  <Svg><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></Svg>
);
export const AgentIcon = (): React.ReactElement => (
  <Svg><path d="M12 8V4M8 8h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z" /><circle cx={9.5} cy={13} r={0.5} fill="currentColor" /><circle cx={14.5} cy={13} r={0.5} fill="currentColor" /></Svg>
);
export const FeedbackIcon = (): React.ReactElement => (
  <Svg><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></Svg>
);
