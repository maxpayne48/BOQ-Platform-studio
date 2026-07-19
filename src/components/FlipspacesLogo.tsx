import React from "react";
import logo from "../assets/logo.png"; // Change to logo.svg if using SVG

interface FlipspacesLogoProps {
  className?: string;
  light?: boolean;
}

export default function FlipspacesLogo({
  className = "",
}: FlipspacesLogoProps) {
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <img
        src={logo}
        alt="Company Logo"
        className="
          h-14
          md:h-16
          lg:h-20
          w-auto
          object-contain
          select-none
        "
        draggable={false}
      />
    </div>
  );
}