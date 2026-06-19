import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Иконки lucide-react тянутся барелл-импортом — оптимизатор превращает их
  // в точечные импорты, уменьшая бандл и ускоряя загрузку/сборку.
  experimental: {
    optimizePackageImports: ["lucide-react"]
  }
};

export default nextConfig;
