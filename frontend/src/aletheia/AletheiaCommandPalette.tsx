"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckSquare,
  CalendarClock,
  ClipboardList,
  FileOutput,
  FilePlus2,
  FileText,
  FolderOpen,
  Gavel,
  ListChecks,
  LoaderCircle,
  Scale,
  Search,
  Settings,
  X,
} from "lucide-react";
import {
  searchAletheia,
  type AletheiaSearchResult,
  type AletheiaSearchResultKind,
} from "@/app/lib/aletheiaApi";
import { cn } from "@/lib/utils";
import {
  groupAletheiaSearchResults,
  movePaletteSelection,
} from "./commandPaletteModel";

const OPEN_EVENT = "aletheia-open-command-bar";
const SEARCH_LIMIT = 40;
const SEARCH_DELAY_MS = 200;

const kindPresentation: Record<
  AletheiaSearchResultKind,
  { label: string; icon: typeof Scale }
> = {
  matter: { label: "案件", icon: Scale },
  document: { label: "案卷", icon: FileText },
  fact: { label: "事实", icon: ListChecks },
  position: { label: "请求权与抗辩", icon: Gavel },
  deadline: { label: "期限", icon: CalendarClock },
  task: { label: "待办", icon: CheckSquare },
  work_product: { label: "工作产品", icon: FileOutput },
};

function formatStatus(status: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    open: "待办",
    completed: "已完成",
    invalidated: "已失效",
    proposed: "待确认",
    confirmed: "已确认",
    rejected: "已驳回",
    disputed: "有争议",
    withdrawn: "已撤回",
    parsed: "已解析",
    pending: "待处理",
    needs_ocr: "需要 OCR",
    processing: "处理中",
    failed: "处理失败",
    in_progress: "进行中",
    needs_review: "待复核",
    generated: "已生成",
    accepted: "已采纳",
    superseded: "已替代",
    approved: "已批准",
    archived: "已归档",
    stale: "已过期",
  };
  return labels[status] ?? "状态未知";
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
}

export function openAletheiaCommandPalette() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

export function AletheiaCommandPalette() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AletheiaSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchAttempt, setSearchAttempt] = useState(0);
  const trimmedQuery = query.trim();
  const searchMode = trimmedQuery.length >= 2;

  const closePalette = useCallback(() => setOpen(false), []);
  const openPalette = useCallback(() => {
    setQuery("");
    setResults([]);
    setError(null);
    setLoading(false);
    setActiveIndex(0);
    setOpen(true);
  }, []);

  const commands = useMemo(
    () => [
      {
        label: "新建案件",
        hint: "创建民商事诉讼案件",
        icon: FilePlus2,
        run: () => router.push("/aletheia/matters?newMatter=1"),
      },
      {
        label: "打开案件",
        hint: "浏览本地案件",
        icon: FolderOpen,
        run: () => router.push("/aletheia/matters"),
      },
      {
        label: "打开工作队列",
        hint: "查看待办、已完成和已失效任务",
        icon: ClipboardList,
        run: () => router.push("/aletheia/tasks"),
      },
      {
        label: "设置",
        hint: "配置本地客户端",
        icon: Settings,
        run: () => router.push("/aletheia/settings"),
      },
    ],
    [router],
  );

  const groupedResults = useMemo(
    () => groupAletheiaSearchResults(results),
    [results],
  );
  const orderedResults = useMemo(
    () => groupedResults.flatMap((group) => group.results),
    [groupedResults],
  );
  const itemCount = searchMode ? orderedResults.length : commands.length;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
      }
      if (event.key === "Escape") closePalette();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_EVENT, openPalette);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_EVENT, openPalette);
    };
  }, [closePalette, openPalette]);

  useEffect(() => {
    if (!open || !searchMode) return;

    const controller = new AbortController();
    let disposed = false;

    const timer = window.setTimeout(() => {
      void searchAletheia(trimmedQuery, SEARCH_LIMIT, controller.signal)
        .then((response) => {
          if (disposed) return;
          setResults(response.results);
          setLoading(false);
        })
        .catch((requestError: unknown) => {
          if (disposed || controller.signal.aborted) return;
          setError(
            requestError instanceof Error
              ? requestError.message
              : "搜索暂时不可用。",
          );
          setLoading(false);
        });
    }, SEARCH_DELAY_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, searchAttempt, searchMode, trimmedQuery]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open || itemCount === 0) return;
    document
      .getElementById(`aletheia-command-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, itemCount, open]);

  const navigateToResult = useCallback(
    (result: AletheiaSearchResult) => {
      closePalette();
      if (/^https?:\/\//.test(result.href)) {
        window.location.assign(result.href);
        return;
      }
      router.push(result.href);
    },
    [closePalette, router],
  );

  function runActiveItem() {
    if (searchMode) {
      const result = orderedResults[activeIndex];
      if (result) navigateToResult(result);
      return;
    }
    const command = commands[activeIndex];
    if (!command) return;
    closePalette();
    command.run();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/20 px-3 pt-[10dvh] sm:px-5 sm:pt-[14dvh]"
      onMouseDown={closePalette}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索与命令"
        className="w-full max-w-2xl overflow-hidden rounded-lg border border-gray-300 bg-white shadow-[0_12px_36px_rgba(15,23,42,0.16)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-gray-200 px-4">
          {loading ? (
            <LoaderCircle
              aria-label="正在搜索"
              className="h-4 w-4 animate-spin text-gray-500"
            />
          ) : (
            <Search className="h-4 w-4 text-gray-500" />
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              const nextQuery = event.target.value;
              setQuery(nextQuery);
              setActiveIndex(0);
              setError(null);
              setResults([]);
              setLoading(nextQuery.trim().length >= 2);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) =>
                  movePaletteSelection(
                    current,
                    itemCount,
                    event.key === "ArrowDown" ? 1 : -1,
                  ),
                );
              }
              if (event.key === "Enter") {
                event.preventDefault();
                runActiveItem();
              }
            }}
            placeholder="搜索案件、案卷、事实、请求权抗辩、期限、待办和工作产品"
            role="combobox"
            aria-expanded="true"
            aria-controls="aletheia-command-results"
            aria-activedescendant={
              itemCount > 0
                ? `aletheia-command-option-${activeIndex}`
                : undefined
            }
            className="h-13 min-w-0 flex-1 bg-transparent text-[15px] text-gray-950 outline-none placeholder:text-gray-400"
          />
          <button
            type="button"
            onClick={closePalette}
            aria-label="关闭搜索"
            title="关闭"
            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          id="aletheia-command-results"
          role="listbox"
          aria-label={searchMode ? "搜索结果" : "快捷命令"}
          className="max-h-[min(60dvh,520px)] overflow-y-auto p-2"
        >
          {!searchMode ? (
            <>
              <div className="flex items-center justify-between px-2 pb-1.5 pt-1">
                <p className="text-[11px] font-semibold uppercase text-gray-500">
                  快捷命令
                </p>
              </div>
              {commands.map((item, index) => (
                <button
                  id={`aletheia-command-option-${index}`}
                  role="option"
                  aria-selected={activeIndex === index}
                  key={item.label}
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    closePalette();
                    item.run();
                  }}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 rounded-md px-3 py-2 text-left",
                    activeIndex === index ? "bg-gray-100" : "hover:bg-gray-50",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0 text-gray-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-gray-900">
                      {item.label}
                    </span>
                    <span className="block truncate text-xs text-gray-500">
                      {item.hint}
                    </span>
                  </span>
                </button>
              ))}
            </>
          ) : loading ? (
            <div
              role="status"
              className="flex min-h-40 flex-col items-center justify-center gap-2 text-center"
            >
              <LoaderCircle className="h-5 w-5 animate-spin text-gray-500" />
              <p className="text-sm font-medium text-gray-700">正在搜索</p>
              <p className="text-xs text-gray-500">
                正在检索本地工作区
              </p>
            </div>
          ) : error ? (
            <div
              role="alert"
              className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center"
            >
              <p className="text-sm font-medium text-gray-900">
                搜索暂时不可用
              </p>
              <p className="max-w-sm text-xs leading-5 text-gray-500">
                请稍后重试。当前未显示任何搜索结果。
              </p>
              <button
                type="button"
                onClick={() => {
                  setLoading(true);
                  setError(null);
                  setSearchAttempt((attempt) => attempt + 1);
                }}
                className="mt-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                重试
              </button>
            </div>
          ) : orderedResults.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-1.5 px-6 text-center">
              <p className="text-sm font-medium text-gray-900">
                未找到结果
              </p>
              <p className="text-xs text-gray-500">
                可尝试案件名称、案卷标题、事实、请求权抗辩、期限、待办或工作产品。
              </p>
            </div>
          ) : (
            groupedResults.map((group) => {
              const presentation = kindPresentation[group.kind];
              const GroupIcon = presentation.icon;
              const groupStartIndex = orderedResults.indexOf(group.results[0]);
              return (
                <div
                  key={group.kind}
                  data-testid={`search-group-${group.kind}`}
                  className="pb-2 last:pb-0"
                >
                  <div
                    data-testid={`search-group-label-${group.kind}`}
                    className="flex items-center gap-2 px-2 pb-1.5 pt-1.5 text-[11px] font-semibold uppercase text-gray-500"
                  >
                    <GroupIcon className="h-3.5 w-3.5" />
                    <span>{presentation.label}</span>
                    <span className="font-normal text-gray-400">
                      {group.results.length}
                    </span>
                  </div>
                  {group.results.map((result, groupIndex) => {
                    const index = groupStartIndex + groupIndex;
                    const ResultIcon = kindPresentation[result.kind].icon;
                    const updatedAt = formatUpdatedAt(result.updatedAt);
                    return (
                      <button
                        id={`aletheia-command-option-${index}`}
                        role="option"
                        aria-selected={activeIndex === index}
                        key={`${result.kind}-${result.id}`}
                        type="button"
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => navigateToResult(result)}
                        className={cn(
                          "flex w-full items-start gap-3 rounded-md px-3 py-2.5 text-left",
                          activeIndex === index
                            ? "bg-gray-100"
                            : "hover:bg-gray-50",
                        )}
                      >
                        <ResultIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium text-gray-950">
                              {result.title}
                            </span>
                            {result.status ? (
                              <span className="shrink-0 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] capitalize text-gray-500">
                                {formatStatus(result.status)}
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-gray-500">
                            {result.snippet || result.matterTitle}
                          </span>
                          <span className="mt-1 flex items-center gap-2 text-[11px] text-gray-400">
                            <span className="truncate">
                              {result.matterTitle}
                            </span>
                            {updatedAt ? (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="shrink-0">
                          更新于 {updatedAt}
                                </span>
                              </>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
