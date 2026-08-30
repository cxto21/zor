
import React from 'react';

interface RetroWindowProps {
  title: string;
  children: React.ReactNode;
  icon?: string;
  className?: string;
}

const RetroWindow: React.FC<RetroWindowProps> = ({ title, children, icon, className = "" }) => {
  return (
    <div className={`retro-border p-1 flex flex-col ${className}`}>
      <div className="win95-title mb-1 flex items-center gap-2">
        <div className="flex items-center gap-1">
          {icon && <span className="text-xs">{icon}</span>}
          <span className="text-sm uppercase tracking-wider">{title}</span>
        </div>
        <div className="flex gap-1">
          <button className="retro-border bg-[#c0c0c0] text-black px-1 leading-none text-xs h-4 w-4 flex items-center justify-center">_</button>
          <button className="retro-border bg-[#c0c0c0] text-black px-1 leading-none text-xs h-4 w-4 flex items-center justify-center">□</button>
          <button className="retro-border bg-[#c0c0c0] text-black px-1 leading-none text-xs h-4 w-4 flex items-center justify-center font-bold">×</button>
        </div>
      </div>
      <div className="retro-border-inset p-4 bg-white flex-1 overflow-auto text-black">
        {children}
      </div>
    </div>
  );
};

export default RetroWindow;
