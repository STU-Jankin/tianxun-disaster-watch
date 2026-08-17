import type { Metadata } from "next";
import { Dashboard } from "./dashboard";

export const metadata: Metadata = {
  title: "星联体·天巡灾情实时预报系统",
  description: "面向自有卫星任务规划的全球自然灾害实时发现与重点区域预警系统。",
};

export default function Home() {
  return <Dashboard />;
}
