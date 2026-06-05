"use client";

import { Alert, AlertDescription, AlertTitle } from "@opencompany/ui/components/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@opencompany/ui/components/avatar";
import { Badge } from "@opencompany/ui/components/badge";
import { Button, buttonVariants } from "@opencompany/ui/components/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@opencompany/ui/components/card";
import { Checkbox } from "@opencompany/ui/components/checkbox";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@opencompany/ui/components/command";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@opencompany/ui/components/dialog";
import { Input } from "@opencompany/ui/components/input";
import { Label } from "@opencompany/ui/components/label";
import { Popover, PopoverContent, PopoverTrigger } from "@opencompany/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@opencompany/ui/components/select";
import { Separator } from "@opencompany/ui/components/separator";
import { Skeleton } from "@opencompany/ui/components/skeleton";
import { toast } from "@opencompany/ui/components/sonner";
import { Spinner } from "@opencompany/ui/components/spinner";
import { Switch } from "@opencompany/ui/components/switch";
import { Tabs, TabsIndicator, TabsList, TabsPanel, TabsTab } from "@opencompany/ui/components/tabs";
import { Textarea } from "@opencompany/ui/components/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@opencompany/ui/components/tooltip";
import {
  CheckCircle2,
  CreditCard,
  Info,
  Mail,
  Settings,
  TriangleAlert,
  User,
} from "@opencompany/ui/icons";
import { cn } from "@opencompany/ui/lib/utils";
import type * as React from "react";
import { useState } from "react";
import type { ComponentSlug } from "@/lib/site";

export type Example = { title: string; content: React.ReactNode };
export type RegistryEntry = { description: string; examples: Example[] };

function CheckboxDemo() {
  return (
    <div className="flex flex-col gap-3">
      <Label className="gap-2">
        <Checkbox defaultChecked /> Accept terms and conditions
      </Label>
      <Label className="gap-2">
        <Checkbox /> Subscribe to the newsletter
      </Label>
      <Label className="gap-2 opacity-60">
        <Checkbox disabled /> Disabled option
      </Label>
    </div>
  );
}

function SwitchDemo() {
  const [on, setOn] = useState(true);
  return (
    <div className="flex flex-col gap-3">
      <Label className="gap-3">
        <Switch checked={on} onCheckedChange={setOn} /> Notifications {on ? "on" : "off"}
      </Label>
      <Label className="gap-3 opacity-60">
        <Switch disabled /> Disabled
      </Label>
    </div>
  );
}

function SelectDemo() {
  return (
    <Select>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Select a workspace" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Workspaces</SelectLabel>
          <SelectItem value="engineering">Engineering</SelectItem>
          <SelectItem value="design">Design</SelectItem>
          <SelectItem value="marketing">Marketing</SelectItem>
          <SelectItem value="operations">Operations</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function DialogDemo() {
  return (
    <Dialog>
      <DialogTrigger className={cn(buttonVariants({ variant: "outline" }))}>
        Open dialog
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename workspace</DialogTitle>
          <DialogDescription>
            Give your workspace a new name. This is visible to all members.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ws-name">Name</Label>
          <Input id="ws-name" defaultValue="Acme Inc." />
        </div>
        <DialogFooter>
          <DialogClose className={cn(buttonVariants({ variant: "ghost" }))}>Cancel</DialogClose>
          <DialogClose className={cn(buttonVariants())}>Save changes</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PopoverDemo() {
  return (
    <Popover>
      <PopoverTrigger className={cn(buttonVariants({ variant: "outline" }))}>
        Open popover
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">Dimensions</p>
          <p className="text-sm text-muted-foreground">
            Set the dimensions for the layer. Popovers anchor to their trigger.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CommandDemo() {
  return (
    <Command className="w-full max-w-md rounded-lg border border-border">
      <CommandInput placeholder="Type a command or search…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Suggestions">
          <CommandItem>
            <User /> Profile
            <CommandShortcut>⌘P</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <CreditCard /> Billing
            <CommandShortcut>⌘B</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <Settings /> Settings
            <CommandShortcut>⌘S</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function SonnerDemo() {
  return (
    <div className="flex flex-wrap gap-3">
      <Button
        variant="outline"
        onClick={() => toast("Workspace saved", { description: "Your changes have been saved." })}
      >
        Show toast
      </Button>
      <Button variant="outline" onClick={() => toast.success("Deployment succeeded")}>
        Success
      </Button>
      <Button variant="outline" onClick={() => toast.error("Something went wrong")}>
        Error
      </Button>
    </div>
  );
}

export const registry: Record<ComponentSlug, RegistryEntry> = {
  alert: {
    description: "Callout for short, important messages and status feedback.",
    examples: [
      {
        title: "Variants",
        content: (
          <div className="flex w-full max-w-md flex-col gap-3">
            <Alert>
              <Info />
              <AlertTitle>Heads up</AlertTitle>
              <AlertDescription>You can add components to your app.</AlertDescription>
            </Alert>
            <Alert variant="success">
              <CheckCircle2 />
              <AlertTitle>Deployment succeeded</AlertTitle>
              <AlertDescription>Your changes are live.</AlertDescription>
            </Alert>
            <Alert variant="warning">
              <TriangleAlert />
              <AlertTitle>Approaching limit</AlertTitle>
              <AlertDescription>You have used 90% of your quota.</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>Your session has expired.</AlertDescription>
            </Alert>
          </div>
        ),
      },
    ],
  },
  avatar: {
    description: "Image element with a text fallback for representing a user.",
    examples: [
      {
        title: "With image and fallback",
        content: (
          <div className="flex items-center gap-4">
            <Avatar>
              <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
              <AvatarFallback>CN</AvatarFallback>
            </Avatar>
            <Avatar className="size-12">
              <AvatarFallback>OC</AvatarFallback>
            </Avatar>
            <Avatar className="size-7">
              <AvatarFallback>AB</AvatarFallback>
            </Avatar>
          </div>
        ),
      },
    ],
  },
  badge: {
    description: "Small label for statuses, counts, and metadata.",
    examples: [
      {
        title: "Variants",
        content: (
          <div className="flex flex-wrap gap-2">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="success">Success</Badge>
            <Badge variant="warning">Warning</Badge>
            <Badge variant="info">Info</Badge>
            <Badge variant="brand">Brand</Badge>
          </div>
        ),
      },
    ],
  },
  button: {
    description: "Triggers an action or event.",
    examples: [
      {
        title: "Variants",
        content: (
          <div className="flex flex-wrap gap-3">
            <Button>Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="link">Link</Button>
          </div>
        ),
      },
      {
        title: "Sizes & states",
        content: (
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
            <Button size="icon" aria-label="Mail">
              <Mail />
            </Button>
            <Button disabled>
              <Spinner className="text-primary-foreground" /> Loading
            </Button>
          </div>
        ),
      },
    ],
  },
  card: {
    description: "Container that groups related content and actions.",
    examples: [
      {
        title: "Example",
        content: (
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Create project</CardTitle>
              <CardDescription>Deploy your new project in one click.</CardDescription>
              <CardAction>
                <Badge variant="secondary">New</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Label htmlFor="card-name">Name</Label>
              <Input id="card-name" placeholder="Project name" />
            </CardContent>
            <CardFooter className="justify-end gap-2">
              <Button variant="ghost">Cancel</Button>
              <Button>Deploy</Button>
            </CardFooter>
          </Card>
        ),
      },
    ],
  },
  checkbox: {
    description: "Toggle a single option on or off.",
    examples: [{ title: "Example", content: <CheckboxDemo /> }],
  },
  command: {
    description: "Fast, composable command palette built on cmdk.",
    examples: [{ title: "Inline", content: <CommandDemo /> }],
  },
  dialog: {
    description: "A modal overlay for focused tasks and confirmations.",
    examples: [{ title: "Example", content: <DialogDemo /> }],
  },
  input: {
    description: "Single-line text field.",
    examples: [
      {
        title: "Variants",
        content: (
          <div className="flex w-full max-w-sm flex-col gap-3">
            <Input placeholder="Default input" />
            <Input placeholder="Disabled" disabled />
            <Input placeholder="Invalid" aria-invalid />
          </div>
        ),
      },
    ],
  },
  label: {
    description: "Accessible caption associated with a form control.",
    examples: [
      {
        title: "With input",
        content: (
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" placeholder="you@example.com" />
          </div>
        ),
      },
    ],
  },
  popover: {
    description: "Floating content anchored to a trigger.",
    examples: [{ title: "Example", content: <PopoverDemo /> }],
  },
  select: {
    description: "Choose a single value from a list.",
    examples: [{ title: "Example", content: <SelectDemo /> }],
  },
  separator: {
    description: "Visually divides content.",
    examples: [
      {
        title: "Orientations",
        content: (
          <div className="flex w-full max-w-sm flex-col gap-4">
            <div className="text-sm">Above</div>
            <Separator />
            <div className="text-sm">Below</div>
            <div className="flex h-6 items-center gap-3 text-sm">
              <span>Docs</span>
              <Separator orientation="vertical" />
              <span>Components</span>
              <Separator orientation="vertical" />
              <span>Tokens</span>
            </div>
          </div>
        ),
      },
    ],
  },
  skeleton: {
    description: "Placeholder shown while content is loading.",
    examples: [
      {
        title: "Example",
        content: (
          <div className="flex w-full max-w-sm items-center gap-4">
            <Skeleton className="size-12 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          </div>
        ),
      },
    ],
  },
  sonner: {
    description: "Opinionated toast notifications powered by Sonner.",
    examples: [{ title: "Triggers", content: <SonnerDemo /> }],
  },
  spinner: {
    description: "Indicates an indeterminate loading state.",
    examples: [
      {
        title: "Sizes",
        content: (
          <div className="flex items-center gap-4">
            <Spinner className="size-4" />
            <Spinner className="size-6" />
            <Spinner className="size-8" />
          </div>
        ),
      },
    ],
  },
  switch: {
    description: "Toggle a setting on or off.",
    examples: [{ title: "Example", content: <SwitchDemo /> }],
  },
  tabs: {
    description: "Switch between related panels of content.",
    examples: [
      {
        title: "Example",
        content: (
          <Tabs defaultValue="account" className="w-full max-w-md">
            <TabsList>
              <TabsIndicator />
              <TabsTab value="account">Account</TabsTab>
              <TabsTab value="password">Password</TabsTab>
              <TabsTab value="team">Team</TabsTab>
            </TabsList>
            <TabsPanel value="account" className="pt-3 text-sm text-muted-foreground">
              Manage your account details and profile.
            </TabsPanel>
            <TabsPanel value="password" className="pt-3 text-sm text-muted-foreground">
              Change your password and security settings.
            </TabsPanel>
            <TabsPanel value="team" className="pt-3 text-sm text-muted-foreground">
              Invite and manage team members.
            </TabsPanel>
          </Tabs>
        ),
      },
    ],
  },
  textarea: {
    description: "Multi-line text field.",
    examples: [
      {
        title: "With label",
        content: (
          <div className="flex w-full max-w-sm flex-col gap-2">
            <Label htmlFor="message">Message</Label>
            <Textarea id="message" placeholder="Type your message here." />
          </div>
        ),
      },
    ],
  },
  tooltip: {
    description: "Contextual hint shown on hover or focus.",
    examples: [
      {
        title: "Example",
        content: (
          <Tooltip>
            <TooltipTrigger className={cn(buttonVariants({ variant: "outline" }))}>
              Hover me
            </TooltipTrigger>
            <TooltipContent>Add to library</TooltipContent>
          </Tooltip>
        ),
      },
    ],
  },
};
