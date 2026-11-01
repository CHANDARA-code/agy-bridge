import type { CSSProperties } from "react";
import { ApiOutlined } from "@ant-design/icons";
import deepseek from "../assets/service-logos/deepseek.svg";
import groq from "../assets/service-logos/groq.svg";
import kimi from "../assets/service-logos/kimi.svg";
import minimax from "../assets/service-logos/minimax.svg";
import openai from "../assets/service-logos/openai.svg";
import openrouter from "../assets/service-logos/openrouter.svg";
import qwen from "../assets/service-logos/qwen.svg";
import volcengine from "../assets/service-logos/volcengine.svg";
import zai from "../assets/service-logos/zai.svg";
import zhipu from "../assets/service-logos/zhipu.svg";
import { CLAUDE_ICON } from "../providerIcons";

const LOGOS: Record<string, { src: string; mono?: boolean }> = {
  deepseek: { src: deepseek },
  kimi: { src: kimi, mono: true },
  "kimi-cn": { src: kimi, mono: true },
  "kimi-codex": { src: kimi, mono: true },
  zai: { src: zai, mono: true },
  zhipu: { src: zhipu },
  minimax: { src: minimax },
  "minimax-cn": { src: minimax },
  "minimax-codex": { src: minimax },
  alibaba: { src: qwen },
  openrouter: { src: openrouter, mono: true },
  "openrouter-codex": { src: openrouter, mono: true },
  volcengine: { src: volcengine },
  openai: { src: openai, mono: true },
  groq: { src: groq, mono: true },
};

export function ServiceLogo({ service, size = 18, style }: { service: string; size?: number; style?: CSSProperties }) {
  const logo = LOGOS[service];
  const box: CSSProperties = { display: "inline-block", width: size, height: size, flexShrink: 0, verticalAlign: "middle", ...style };
  if (service === "anthropic") {
    return (
      <svg viewBox={CLAUDE_ICON.viewBox} width={size} height={size} style={box} aria-hidden="true">
        <path fill={CLAUDE_ICON.color} d={CLAUDE_ICON.path} />
      </svg>
    );
  }
  if (!logo) return <ApiOutlined aria-hidden style={{ fontSize: size, ...style }} />;
  if (logo.mono) {
    const mask = `url("${logo.src}") center / contain no-repeat`;
    return <span aria-hidden style={{ ...box, backgroundColor: "currentColor", mask, WebkitMask: mask }} />;
  }
  return <img src={logo.src} alt="" width={size} height={size} style={box} />;
}
