import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "opencompany docs",
      url: "/docs",
    },
    links: [
      {
        text: "Open opencompany",
        url: "https://opencompany.chat",
        external: true,
      },
    ],
    githubUrl: "https://github.com/useopencompany/opencompany-experimental",
  };
}
