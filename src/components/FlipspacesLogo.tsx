import React from "react";

interface FlipspacesLogoProps {
  className?: string;
  light?: boolean;
}

export default function FlipspacesLogo({ className = "w-44 h-auto", light = false }: FlipspacesLogoProps) {
  return (
    <svg 
      viewBox="0 0 700 100" 
      className={className} 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Upward pointing triangle on the left */}
      <polygon 
        points="15,80 50,15 85,80" 
        stroke="#FFE200" 
        strokeWidth="8" 
        strokeLinejoin="miter" 
        fill="none" 
      />
      {/* Downward pointing triangle in the middle */}
      <polygon 
        points="70,15 105,80 140,15" 
        stroke="#FFE200" 
        strokeWidth="8" 
        strokeLinejoin="miter" 
        fill="none" 
      />
      
      {/* FLIPSPACES text - clean, elegant, normal weight sans-serif */}
      <text 
        x="165" 
        y="70" 
        fontFamily="'Inter', 'Space Grotesk', system-ui, -apple-system, sans-serif" 
        fontWeight="400" 
        fontSize="76" 
        fill={light ? "white" : "#0f172a"} 
        letterSpacing="2"
      >
        FLIPSPACES
      </text>
    </svg>
  );
}
