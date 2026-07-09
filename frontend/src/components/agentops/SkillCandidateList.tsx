import { CheckCircle2, CircleDashed, LockKeyhole, Sparkles } from "lucide-react";
import type { ProfessionalSkill } from "@/aletheia/agentops";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

function titleize(value: string) {
  return value.replaceAll("_", " ");
}

function statusClass(status: ProfessionalSkill["approval_status"]) {
  if (status === "approved") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "rejected") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (status === "deprecated") {
    return "border-gray-200 bg-gray-50 text-gray-600";
  }
  return "border-amber-200 bg-amber-50 text-amber-800";
}

export function SkillCandidateList({
  existingSkills,
  suggestedSkills,
}: {
  existingSkills: ProfessionalSkill[];
  suggestedSkills: ProfessionalSkill[];
}) {
  const approvedSkills = existingSkills.filter(
    (skill) => skill.approval_status === "approved",
  );
  const candidateSkills = [
    ...existingSkills.filter((skill) => skill.approval_status === "candidate"),
    ...suggestedSkills,
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-gray-500" />
            <h3 className="text-sm font-semibold uppercase text-gray-500">
              Candidate Skills
            </h3>
          </div>
          <Badge
            variant="outline"
            className="rounded-md border-amber-200 bg-amber-50 text-amber-800"
          >
            Approval required
          </Badge>
        </div>

        <div className="mt-4 space-y-3">
          {candidateSkills.length === 0 ? (
            <p className="rounded-md border border-dashed border-gray-200 p-3 text-sm text-gray-500">
              No repeated feedback pattern has crossed the candidate threshold.
            </p>
          ) : (
            candidateSkills.map((skill, index) => (
              <article
                key={`${skill.id}-${skill.version}-${index}`}
                className="rounded-md border border-gray-100 bg-gray-50 p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-950">
                      {skill.name}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-gray-600">
                      {skill.description}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn("rounded-md", statusClass(skill.approval_status))}
                  >
                    <CircleDashed className="h-3 w-3" />
                    {titleize(skill.approval_status)}
                  </Badge>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-gray-600 sm:grid-cols-2">
                  <p>
                    <span className="font-semibold text-gray-800">Triggers:</span>{" "}
                    {skill.trigger_conditions.join("; ")}
                  </p>
                  <p>
                    <span className="font-semibold text-gray-800">Eval cases:</span>{" "}
                    {skill.created_from_eval_case_ids.length || "review/gate pattern"}
                  </p>
                </div>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex items-center gap-2">
          <LockKeyhole className="h-4 w-4 text-gray-500" />
          <h3 className="text-sm font-semibold uppercase text-gray-500">
            Approved Playbook Skills
          </h3>
        </div>

        <div className="mt-4 space-y-3">
          {approvedSkills.length === 0 ? (
            <p className="rounded-md border border-dashed border-gray-200 p-3 text-sm text-gray-500">
              No human-approved playbook skill is active for this workspace.
            </p>
          ) : (
            approvedSkills.map((skill, index) => (
              <article
                key={`${skill.id}-${skill.version}-${index}`}
                className="rounded-md border border-emerald-100 bg-emerald-50 p-3"
              >
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-emerald-950">
                      {skill.name}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-emerald-800">
                      {skill.description}
                    </p>
                    <p className="mt-2 text-xs text-emerald-700">
                      v{skill.version} from{" "}
                      {skill.created_from_eval_case_ids.length} eval case
                      {skill.created_from_eval_case_ids.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
