"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { JSONContent } from "@tiptap/react";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { type AddedSkill, AddSkillDialog } from "@/components/agent-editor/AddSkillDialog";
import { AgentEditor, type AgentEditorHandle } from "@/components/agent-editor/AgentEditor";
import {
  ADD_SKILL_MENTION_ID,
  type AgentMentionItem,
  type AgentSkillCatalogEntry,
} from "@/components/agent-editor/tools";
import { useWorkspaceContext } from "@/components/WorkspaceContext";

type Props = {
  initialBody: string;
  initialContent?: JSONContent | null;
  onChange: (body: string, content: JSONContent) => void;
  mentionItems?: AgentMentionItem[];
  onMentionSelect?: (item: AgentMentionItem) => void;
};

export const AgentEditorWithAddSkillDialog = forwardRef<AgentEditorHandle, Props>(
  function AgentEditorWithAddSkillDialog({ onMentionSelect, ...editorProps }, ref) {
    const { workspaceId } = useWorkspaceContext();
    const queryClient = useQueryClient();
    const editorRef = useRef<AgentEditorHandle>(null);
    const [showAddSkillDialog, setShowAddSkillDialog] = useState(false);

    useImperativeHandle(
      ref,
      () => ({
        selectRepositoryMention(repository) {
          editorRef.current?.selectRepositoryMention(repository);
        },
        insertSkillMention(skill) {
          editorRef.current?.insertSkillMention(skill);
        },
      }),
      [],
    );

    const handleAddedSkill = (skill: AddedSkill) => {
      setShowAddSkillDialog(false);
      queryClient.setQueryData<AgentSkillCatalogEntry[]>(
        ["workspace-skills", workspaceId],
        (skills = []) => {
          if (skills.some((existing) => existing.id === skill.id)) return skills;
          return [
            ...skills,
            {
              id: skill.id,
              name: skill.name,
              description: skill.description,
              source: skill.source,
            },
          ];
        },
      );
      queryClient.invalidateQueries({ queryKey: ["workspace-skills", workspaceId] });
      editorRef.current?.insertSkillMention({ id: skill.id });
    };

    return (
      <>
        <AgentEditor
          {...editorProps}
          ref={editorRef}
          onMentionSelect={(item) => {
            if (item.kind === "skill" && item.id === ADD_SKILL_MENTION_ID) {
              setShowAddSkillDialog(true);
              return;
            }
            onMentionSelect?.(item);
          }}
        />
        {showAddSkillDialog ? (
          <AddSkillDialog onClose={() => setShowAddSkillDialog(false)} onAdded={handleAddedSkill} />
        ) : null}
      </>
    );
  },
);
