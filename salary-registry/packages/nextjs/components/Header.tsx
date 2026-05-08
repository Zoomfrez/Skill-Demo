"use client";

import React, { useRef } from "react";
import { RainbowKitCustomConnectButton } from "~~/components/helper";
import { useOutsideClick } from "~~/hooks/helper";

/**
 * Site header
 */
export const Header = () => {
  const burgerMenuRef = useRef<HTMLDetailsElement>(null);
  useOutsideClick(burgerMenuRef, () => {
    burgerMenuRef?.current?.removeAttribute("open");
  });

  return (
    <div className="sticky lg:static top-0 navbar min-h-0 shrink-0 justify-between z-20 px-4 sm:px-6 border-b border-gray-200 bg-white">
      <div className="navbar-start">
        <span className="font-bold text-gray-900 text-base tracking-tight">Jinshi&apos;s Demo</span>
      </div>
      <div className="navbar-end">
        <RainbowKitCustomConnectButton />
      </div>
    </div>
  );
};
