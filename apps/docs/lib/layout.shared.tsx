import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "OpenCompany docs",
      url: "/docs",
    },
    links: [
      {
        text: "Open OpenCompany",
        url: "https://opencompany.chat",
        external: true,
      },
    ],
    githubUrl: "https://github.com/useopencompany/opencompany-experimental",
  };
}
