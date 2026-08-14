import type { Metadata } from "next";
import { Dashboard } from "./dashboard";

export const metadata: Metadata = {
  title: "天巡 · 全球自然灾害预警",
  description: "面向自有卫星任务规划的全球自然灾害实时发现与重点区域预警系统。",
};

export default function Home() {
  return <Dashboard />;
}
