"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    MoreHorizontal,
    Pencil,
    Plus,
    Search,
    Square,
    ArrowRight,
    ChevronDown,
    Trash2,
    X,
} from "lucide-react";
import { VeraIcon } from "@/app/components/chat/vera-icon";
import {
    streamTabularChat,
    getTabularChats,
    getTabularChatMessages,
    deleteTabularChat,
    renameTabularChat,
    mapTRMessages,
    type TRChat,
    type TRCitationAnnotation,
} from "@/app/lib/mikeApi";
import type { ColumnConfig, Document } from "../shared/types";
import { ModelToggle } from "../assistant/ModelToggle";
import { ApiKeyMissingPopup } from "../popups/ApiKeyMissingPopup";
import { hasAssistantWorkInProgress } from "../assistant/message/eventUtils";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import {
    getModelProvider,
    isModelAvailable,
    type ModelProvider,
} from "@/app/lib/modelAvailability";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import {
    APP_SURFACE_ACTIVE_CLASS,
    APP_SURFACE_HOVER_CLASS,
    LIQUID_PANEL_SURFACE_CLASS,
} from "@/app/components/ui/liquid-surface";
import {
    LiquidDropdownButton,
    LiquidDropdownSurface,
} from "@/app/components/ui/liquid-dropdown";
import { cn } from "@/app/lib/utils";
import {
    appendThinkingPlaceholder,
    appendReasoningDelta,
    ensureStreamingContentEvent,
    finishReasoningBlock,
    withoutStreamingPlaceholders,
    type TRMessage,
} from "./tabularChatEvents";
import {
    parseTabularCitationAnnotations,
    reduceTabularToolEvent,
} from "./tabularChatProtocol";
import { iterateTabularChatEvents } from "./tabularChatStream";
import { useTabularChatSession } from "./useTabularChatSession";

interface Props {
    reviewId: string;
    reviewTitle?: string | null;
    projectName?: string | null;
    columns: ColumnConfig[];
    documents: Document[];
    onCitationClick: (citation: TRCitationAnnotation) => void;
    onClose: () => void;
    initialChatId?: string | null;
    onChatIdChange?: (chatId: string | null) => void;
}

// ---------------------------------------------------------------------------
// Citation preprocessing (matches AssistantMessage.tsx pattern)
// ---------------------------------------------------------------------------

function preprocessTRCitations(
    text: string,
    annotations: TRCitationAnnotation[],
    citationsList: TRCitationAnnotation[],
): string {
    return text.replace(/\[(\d+(?:,\s*\d+)*)\]/g, (full, refsStr) => {
        const refs = (refsStr as string)
            .split(",")
            .map((s: string) => parseInt(s.trim(), 10));
        const tokens = refs.flatMap((ref: number) => {
            const ann = annotations.find((a) => a.ref === ref);
            if (!ann) return [];
            const idx = citationsList.length;
            citationsList.push(ann);
            return [`\`§${idx}§\`\u200B`];
        });
        return tokens.length > 0 ? tokens.join("") : full;
    });
}

// ---------------------------------------------------------------------------
// ResponseStatus
// ---------------------------------------------------------------------------

function TRResponseStatus({ isActive }: { isActive: boolean }) {
    const [showDone, setShowDone] = useState(false);
    const [doneVisible, setDoneVisible] = useState(false);
    const wasActiveRef = useRef(false);

    useEffect(() => {
        if (wasActiveRef.current && !isActive) {
            const showDoneTimer = setTimeout(() => {
                setShowDone(true);
                setDoneVisible(true);
            }, 0);
            const hideDoneTimer = setTimeout(() => setDoneVisible(false), 1500);
            wasActiveRef.current = isActive;
            return () => {
                clearTimeout(showDoneTimer);
                clearTimeout(hideDoneTimer);
            };
        }
        if (!wasActiveRef.current && isActive) {
            const resetDoneTimer = setTimeout(() => {
                setShowDone(false);
                setDoneVisible(false);
            }, 0);
            wasActiveRef.current = isActive;
            return () => clearTimeout(resetDoneTimer);
        }
        wasActiveRef.current = isActive;
    }, [isActive]);

    return (
        <div className="w-full h-9 flex items-center mb-2">
            <VeraIcon
                spin={isActive}
                done={showDone && doneVisible}
                mike={!(showDone && doneVisible)}
                size={22}
            />
        </div>
    );
}

// ---------------------------------------------------------------------------
// TRAssistantMessage
// ---------------------------------------------------------------------------

function TRAssistantMessage({
    msg,
    onCitationClick,
}: {
    msg: TRMessage;
    onCitationClick: (citation: TRCitationAnnotation) => void;
}) {
    const annotations = msg.annotations ?? [];
    const citationsList: TRCitationAnnotation[] = [];

    // Pre-process all content events
    const processedTexts: string[] = (msg.events ?? []).map((e) =>
        e.type === "content"
            ? preprocessTRCitations(e.text, annotations, citationsList)
            : "",
    );

    const events = msg.events ?? [];
    const showWorkingStatus = hasAssistantWorkInProgress(
        events,
        !!msg.isStreaming,
    );

    const renderContent = (text: string, key: number) => (
        <div
            key={key}
            className="prose prose-sm max-w-none text-sm leading-relaxed"
        >
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    p: ({ node, ...props }) => (
                        <p className="mb-2 leading-6" {...props} />
                    ),
                    ul: ({ node, ...props }) => (
                        <ul
                            className="list-disc list-outside mb-2 pl-4"
                            {...props}
                        />
                    ),
                    ol: ({ node, ...props }) => (
                        <ol
                            className="list-decimal list-outside mb-2 pl-4"
                            {...props}
                        />
                    ),
                    li: ({ node, ...props }) => (
                        <li className="mb-0.5 leading-6" {...props} />
                    ),
                    strong: ({ node, ...props }) => (
                        <strong className="font-semibold" {...props} />
                    ),
                    code: ({ children }) => {
                        const codeText = String(children);
                        const citMatch = codeText.match(/^§(\d+)§$/);
                        if (citMatch) {
                            const idx = parseInt(citMatch[1]);
                            const cit = citationsList[idx];
                            if (cit) {
                                return (
                                    <button
                                        type="button"
                                        onClick={() => onCitationClick(cit)}
                                        title={`${cit.col_name} · ${cit.doc_name.replace(/\.[^.]+$/, "")}`}
                                        aria-label={`Open source for citation ${cit.ref}: ${cit.col_name}, ${cit.doc_name}`}
                                        className="mx-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-100 align-super font-serif text-[10px] font-medium text-gray-900 transition-colors hover:bg-gray-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
                                    >
                                        {cit.ref}
                                    </button>
                                );
                            }
                        }
                        return (
                            <code className="bg-gray-100 px-1 py-0.5 rounded text-xs font-mono">
                                {children}
                            </code>
                        );
                    },
                }}
            >
                {text}
            </ReactMarkdown>
        </div>
    );

    return (
        <div className="text-gray-900 font-serif">
            <TRResponseStatus isActive={!!msg.isStreaming} />
            {showWorkingStatus && (
                <div
                    role="status"
                    aria-live="polite"
                    className="mb-2 flex items-center gap-2 text-sm text-gray-500"
                >
                    <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 animate-spin rounded-full border border-gray-400 border-t-transparent"
                    />
                    <span>Working…</span>
                </div>
            )}
            {events.length > 0 && (
                <div className="flex flex-col gap-2.5">
                    {events.map((event, index) => {
                        if (event.type === "content") {
                            return renderContent(
                                processedTexts[index],
                                index,
                            );
                        }
                        return null;
                    })}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({
    msg,
    onCitationClick,
}: {
    msg: TRMessage;
    onCitationClick: (citation: TRCitationAnnotation) => void;
}) {
    if (msg.role === "user") {
        return (
            <div className="flex justify-end">
                <div className="max-w-[90%] rounded-md bg-gray-100 px-3 py-2 text-xs text-gray-800 whitespace-pre-wrap">
                    {msg.content}
                </div>
            </div>
        );
    }
    return <TRAssistantMessage msg={msg} onCitationClick={onCitationClick} />;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function TRChatInput({
    isLoading,
    onSubmit,
    onCancel,
    model,
    onModelChange,
    apiKeys,
    onHeightChange,
}: {
    isLoading: boolean;
    onSubmit: (value: string) => void;
    onCancel: () => void;
    model: string;
    onModelChange: (id: string) => void;
    apiKeys?: ApiKeyState;
    onHeightChange: (height: number) => void;
}) {
    const [value, setValue] = useState("");
    const rootRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;

        const notify = () => {
            onHeightChange(root.getBoundingClientRect().height);
        };
        notify();

        const observer = new ResizeObserver(notify);
        observer.observe(root);
        window.addEventListener("resize", notify);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", notify);
        };
    }, [onHeightChange]);

    function resizeTextarea(el: HTMLTextAreaElement) {
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
        el.style.overflowY = el.scrollHeight > 192 ? "auto" : "hidden";
    }

    function resetTextarea() {
        if (!textareaRef.current) return;
        textareaRef.current.style.height = "auto";
        textareaRef.current.style.overflowY = "hidden";
    }

    function handleAction() {
        if (isLoading) {
            onCancel();
            return;
        }
        const trimmed = value.trim();
        if (!trimmed) return;
        setValue("");
        resetTextarea();
        onSubmit(trimmed);
    }

    return (
        <div
            ref={rootRef}
            className={cn(
                "absolute bottom-0 left-0 right-0 z-10 px-3 pb-3",
                "bg-transparent",
            )}
        >
            <div
                className={cn(
                    "pt-2 pb-1.5 flex flex-col gap-1",
                    "rounded-xl border border-white/65 bg-white/60 shadow-[0_4px_10px_rgba(15,23,42,0.12),inset_0_1px_0_rgba(255,255,255,0.85),inset_0_-6px_14px_rgba(255,255,255,0.18)] backdrop-blur-2xl",
                )}
            >
                <textarea
                    ref={textareaRef}
                    rows={1}
                    placeholder="How can I help?"
                    value={value}
                    onChange={(e) => {
                        setValue(e.target.value);
                        resizeTextarea(e.target);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleAction();
                        }
                    }}
                    className="w-full resize-none text-sm bg-transparent outline-none placeholder:text-gray-400 leading-6 max-h-48 overflow-hidden border-0 p-0 pl-3 pr-2 pt-0.5"
                />
                <div className="flex items-center justify-end gap-1.5 pl-1 pr-2">
                    <ModelToggle
                        value={model}
                        onChange={onModelChange}
                        apiKeys={apiKeys}
                    />
                    <button
                        type="button"
                        onClick={handleAction}
                        disabled={!isLoading && !value.trim()}
                        className={cn(
                            "relative bg-gradient-to-b from-neutral-700 to-black text-white rounded-[10px] h-7 w-7 shrink-0 flex items-center justify-center disabled:cursor-default disabled:from-neutral-600 disabled:to-black border border-white/30 active:enabled:scale-95 transition-all duration-150",
                            "shadow-[0_5px_14px_rgba(15,23,42,0.18),inset_0_1px_0_rgba(255,255,255,0.24)]",
                        )}
                    >
                        {isLoading ? (
                            <Square
                                className="h-3.5 w-3.5"
                                fill="currentColor"
                                strokeWidth={0}
                            />
                        ) : (
                            <ArrowRight className="h-3.5 w-3.5" />
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// History dropdown
// ---------------------------------------------------------------------------

function HistoryDropdown({
    chats,
    currentChatId,
    onLoad,
    onRename,
    onDelete,
}: {
    chats: TRChat[];
    currentChatId: string | null;
    onLoad: (chatId: string) => void;
    onRename: (chatId: string, title: string) => void;
    onDelete: (chatId: string) => void;
}) {
    const [query, setQuery] = useState("");
    const [menu, setMenu] = useState<{
        chatId: string;
        top: number;
        left: number;
    } | null>(null);
    const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");
    const filtered = chats
        .filter((c) => c.id !== currentChatId)
        .filter((c) => {
            const label = c.title ?? "";
            return label.toLowerCase().includes(query.toLowerCase());
        });

    function commitRename(chatId: string) {
        const trimmed = renameValue.trim();
        setRenamingChatId(null);
        if (trimmed) onRename(chatId, trimmed);
    }

    return (
        <>
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-white/40">
                <Search className="h-3 w-3 text-gray-400 shrink-0" />
                <input
                    autoFocus
                    type="text"
                    placeholder="Search chats…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="flex-1 text-xs bg-transparent outline-none placeholder:text-gray-400 text-gray-700"
                />
            </div>
            <div
                className="max-h-48 overflow-y-auto p-1"
                onScroll={() => setMenu(null)}
            >
                {filtered.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-gray-400">
                        {chats.filter((c) => c.id !== currentChatId).length ===
                        0
                            ? "No previous chats."
                            : "No matches."}
                    </p>
                ) : (
                    filtered.map((chat) => {
                        const label = chat.title ?? "Chat";
                        if (renamingChatId === chat.id) {
                            return (
                                <input
                                    key={chat.id}
                                    autoFocus
                                    type="text"
                                    value={renameValue}
                                    onChange={(e) =>
                                        setRenameValue(e.target.value)
                                    }
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter")
                                            commitRename(chat.id);
                                        if (e.key === "Escape")
                                            setRenamingChatId(null);
                                    }}
                                    onBlur={() => commitRename(chat.id)}
                                    className={`w-full rounded-lg px-2 py-1.5 text-xs text-gray-700 outline-none ${APP_SURFACE_ACTIVE_CLASS}`}
                                />
                            );
                        }
                        return (
                            <div
                                key={chat.id}
                                className="group relative flex items-center"
                            >
                                <LiquidDropdownButton
                                    onClick={() => onLoad(chat.id)}
                                    className="w-full min-w-0 rounded-lg px-2 py-1.5 pr-7 text-left truncate"
                                >
                                    {label}
                                </LiquidDropdownButton>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        const rect =
                                            e.currentTarget.getBoundingClientRect();
                                        setMenu((v) =>
                                            v?.chatId === chat.id
                                                ? null
                                                : {
                                                      chatId: chat.id,
                                                      top: rect.bottom + 4,
                                                      left: rect.right - 112,
                                                  },
                                        );
                                    }}
                                    title="Chat options"
                                    className={cn(
                                        `absolute right-1.5 flex h-5 w-5 items-center justify-center rounded-full text-gray-400 transition-colors hover:text-gray-700 ${APP_SURFACE_HOVER_CLASS}`,
                                        menu?.chatId === chat.id
                                            ? "opacity-100"
                                            : "opacity-0 group-hover:opacity-100",
                                    )}
                                >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                </button>
                                {menu?.chatId === chat.id &&
                                    createPortal(
                                    <LiquidDropdownSurface
                                        onMouseDown={(e) =>
                                            e.stopPropagation()
                                        }
                                        className="fixed z-[130] w-28 p-1"
                                        style={{
                                            top: menu.top,
                                            left: menu.left,
                                        }}
                                    >
                                        <LiquidDropdownButton
                                            onClick={() => {
                                                setMenu(null);
                                                setRenameValue(
                                                    chat.title ?? "",
                                                );
                                                setRenamingChatId(chat.id);
                                            }}
                                            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left"
                                        >
                                            <Pencil className="h-3 w-3" />
                                            Rename
                                        </LiquidDropdownButton>
                                        <LiquidDropdownButton
                                            onClick={() => {
                                                setMenu(null);
                                                onDelete(chat.id);
                                            }}
                                            className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-red-600 hover:text-red-600 focus:text-red-600"
                                        >
                                            <Trash2 className="h-3 w-3" />
                                            Delete
                                        </LiquidDropdownButton>
                                    </LiquidDropdownSurface>,
                                    document.body,
                                )}
                            </div>
                        );
                    })
                )}
            </div>
        </>
    );
}

// ---------------------------------------------------------------------------
// Header pills (matches PageHeader action group styling)
// ---------------------------------------------------------------------------

const HEADER_PILL_CLASS =
    "flex shrink-0 items-center gap-1 rounded-full border border-white/70 bg-app-surface px-1 py-0.5 shadow-[0_8px_24px_rgba(15,23,42,0.06)] backdrop-blur-2xl";
const HEADER_PILL_BUTTON_CLASS = `flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:text-gray-900 ${APP_SURFACE_HOVER_CLASS}`;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TRChatPanel({
    reviewId,
    reviewTitle,
    projectName,
    columns: _columns,
    documents: _documents,
    onCitationClick,
    onClose,
    initialChatId,
    onChatIdChange,
}: Props) {
    const { profile, updateModelPreference } = useUserProfile();
    const apiKeys = profile?.apiKeys;
    const currentModel = profile?.tabularModel ?? "gemini-3-flash-preview";
    const [apiKeyModalProvider, setApiKeyModalProvider] =
        useState<ModelProvider | null>(null);
    const [chats, setChats] = useState<TRChat[]>([]);
    const [currentChatId, setCurrentChatId] = useState<string | null>(
        initialChatId ?? null,
    );
    const [currentChatTitle, setCurrentChatTitle] = useState<string | null>(
        null,
    );
    const [historyOpen, setHistoryOpen] = useState(false);
    const [isLoadingMessages, setIsLoadingMessages] = useState(false);
    const [minHeight, setMinHeight] = useState("0px");
    const [messagesVisible, setMessagesVisible] = useState(false);
    const [panelWidth, setPanelWidth] = useState(380);
    const [isResizing, setIsResizing] = useState(false);
    const [inputHeight, setInputHeight] = useState(96);

    const resizeStartRef = useRef({ x: 0, width: 380 });

    useEffect(() => {
        if (!isResizing) return;
        const MIN_WIDTH = 280;
        const MAX_WIDTH = 800;
        function onMove(e: MouseEvent) {
            const delta = resizeStartRef.current.x - e.clientX;
            setPanelWidth(
                Math.min(
                    MAX_WIDTH,
                    Math.max(MIN_WIDTH, resizeStartRef.current.width + delta),
                ),
            );
        }
        function onUp() {
            setIsResizing(false);
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
        return () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
    }, [isResizing]);

    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const historyRef = useRef<HTMLDivElement>(null);
    const hasScrolledRef = useRef(false);
    const chatSession = useTabularChatSession();
    const { messages, isLoading } = chatSession;

    // Load existing chats from DB on mount
    useEffect(() => {
        getTabularChats(reviewId)
            .then(setChats)
            .catch(() => {});
    }, [reviewId]);

    // Load messages for an initial chat id (e.g. from URL)
    useEffect(() => {
        if (!initialChatId) return;
        setIsLoadingMessages(true);
        getTabularChatMessages(reviewId, initialChatId)
            .then((raw) =>
                chatSession.replaceMessages(
                    mapTRMessages(raw) as TRMessage[],
                ),
            )
            .catch(() => {})
            .finally(() => setIsLoadingMessages(false));
    }, [reviewId]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fill in title once chats list arrives
    useEffect(() => {
        if (currentChatId && !currentChatTitle) {
            const chat = chats.find((c) => c.id === currentChatId);
            if (chat) setCurrentChatTitle(chat.title ?? null);
        }
    }, [chats, currentChatId, currentChatTitle]);

    // Emit currentChatId changes to parent
    const onChatIdChangeRef = useRef(onChatIdChange);
    useEffect(() => {
        onChatIdChangeRef.current = onChatIdChange;
    });
    useEffect(() => {
        onChatIdChangeRef.current?.(currentChatId);
    }, [currentChatId]);

    useEffect(() => {
        if (messages.length === 0) {
            hasScrolledRef.current = false;
            setMessagesVisible(false);
        } else if (!hasScrolledRef.current) {
            const userMsgCount = messages.filter(
                (m) => m.role === "user",
            ).length;
            if (
                userMsgCount >= 2 &&
                latestUserMessageRef.current &&
                messagesContainerRef.current
            ) {
                setTimeout(() => {
                    const container = messagesContainerRef.current;
                    const element = latestUserMessageRef.current;
                    if (container && element) {
                        container.scrollTo({
                            top: element.offsetTop - 44,
                            behavior: "instant",
                        });
                    }
                    hasScrolledRef.current = true;
                    setMessagesVisible(true);
                }, 100);
            } else {
                hasScrolledRef.current = true;
                setMessagesVisible(true);
            }
        }
    }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        const BOTTOM_PAD = 96;
        const messageContainerTopPadding = 16;
        const messageGap = 16;
        setMinHeight(
            `${Math.max(0, containerEl.clientHeight - BOTTOM_PAD - userEl.offsetHeight - messageContainerTopPadding - messageGap)}px`,
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages.length, latestUserMessageRef.current]);

    useEffect(() => {
        if (!historyOpen) return;
        function handleClick(e: MouseEvent) {
            if (
                historyRef.current &&
                !historyRef.current.contains(e.target as Node)
            ) {
                setHistoryOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [historyOpen]);

    // ---- chat actions ----

    function handleNewChat() {
        setCurrentChatId(null);
        setCurrentChatTitle(null);
        chatSession.replaceMessages([]);
        setHistoryOpen(false);
    }

    async function handleDeleteChat(chatId: string) {
        setChats((prev) => prev.filter((c) => c.id !== chatId));
        if (chatId === currentChatId) {
            setCurrentChatId(null);
            setCurrentChatTitle(null);
            chatSession.replaceMessages([]);
        }
        try {
            await deleteTabularChat(reviewId, chatId);
        } catch {
            /* ignore */
        }
    }

    async function handleRenameChat(chatId: string, title: string) {
        setChats((prev) =>
            prev.map((c) => (c.id === chatId ? { ...c, title } : c)),
        );
        if (chatId === currentChatId) setCurrentChatTitle(title);
        try {
            await renameTabularChat(reviewId, chatId, title);
        } catch {
            /* ignore */
        }
    }

    async function handleLoadChat(chatId: string) {
        const chat = chats.find((c) => c.id === chatId);
        setCurrentChatId(chatId);
        setCurrentChatTitle(chat?.title ?? null);
        chatSession.replaceMessages([]);
        setHistoryOpen(false);
        setIsLoadingMessages(true);
        try {
            const raw = await getTabularChatMessages(reviewId, chatId);
            chatSession.replaceMessages(mapTRMessages(raw) as TRMessage[]);
        } catch {
            /* ignore */
        } finally {
            setIsLoadingMessages(false);
        }
    }

    function handleCancel() {
        chatSession.cancel();
    }

    async function handleSubmit(trimmed: string) {
        if (!trimmed || isLoading) return;
        if (apiKeys && !isModelAvailable(currentModel, apiKeys)) {
            setApiKeyModalProvider(getModelProvider(currentModel));
            return;
        }

        const session = chatSession.start(trimmed);
        if (!session) return;

        setTimeout(() => {
            const container = messagesContainerRef.current;
            const element = latestUserMessageRef.current;
            if (container && element) {
                container.scrollTo({
                    top: element.offsetTop - 44,
                    behavior: "smooth",
                });
            }
        }, 50);

        try {
            const response = await streamTabularChat(
                reviewId,
                session.requestMessages,
                currentChatId,
                session.controller.signal,
                { reviewTitle, projectName },
            );
            for await (const data of iterateTabularChatEvents(response)) {
                const currentEvents = chatSession.getEvents(session.id);
                if (!currentEvents) break;
                try {
                    if (data.type === "chat_id") {
                        if (typeof data.chatId !== "string") continue;
                        const newId = data.chatId;
                        setCurrentChatId(newId);
                        setChats((prev) =>
                            prev.some((c) => c.id === newId)
                                ? prev
                                : [
                                      {
                                          id: newId,
                                          title: null,
                                          created_at:
                                              new Date().toISOString(),
                                          updated_at:
                                              new Date().toISOString(),
                                      },
                                      ...prev,
                                  ],
                        );
                        continue;
                    }

                    if (data.type === "chat_title") {
                        if (
                            typeof data.chatId !== "string" ||
                            typeof data.title !== "string"
                        ) {
                            continue;
                        }
                        const { chatId, title } = data;
                        setChats((prev) =>
                            prev.map((c) =>
                                c.id === chatId ? { ...c, title } : c,
                            ),
                        );
                        setCurrentChatTitle(title);
                        continue;
                    }

                    if (data.type === "reasoning_delta") {
                        chatSession.publishEvents(
                            session.id,
                            appendReasoningDelta(
                                currentEvents,
                                typeof data.text === "string"
                                    ? data.text
                                    : "",
                            ),
                        );
                        continue;
                    }

                    if (data.type === "reasoning_block_end") {
                        chatSession.publishEvents(
                            session.id,
                            appendThinkingPlaceholder(
                                finishReasoningBlock(currentEvents),
                            ),
                        );
                        continue;
                    }

                    if (data.type === "content_delta") {
                        if (typeof data.text !== "string" || !data.text) {
                            continue;
                        }
                        const text = data.text;
                        const next = ensureStreamingContentEvent(
                            currentEvents,
                        );
                        if (next !== currentEvents) {
                            chatSession.publishEvents(session.id, next);
                        }
                        chatSession.appendContent(session.id, text);
                        continue;
                    }

                    const toolTransition = reduceTabularToolEvent(
                        currentEvents,
                        data,
                    );
                    if (toolTransition.handled) {
                        if (toolTransition.events !== currentEvents) {
                            chatSession.publishEvents(
                                session.id,
                                toolTransition.events,
                            );
                        }
                        continue;
                    }

                    if (data.type === "citations") {
                        // End-of-stream signal — scrub any lingering
                        // placeholders so they don't persist into the
                        // finalised message.
                        const cleanEvents = withoutStreamingPlaceholders(
                            currentEvents,
                        );
                        if (cleanEvents !== currentEvents) {
                            chatSession.publishEvents(
                                session.id,
                                cleanEvents,
                            );
                        }
                        const incoming = parseTabularCitationAnnotations(
                            data.citations,
                        );
                        chatSession.updateMessages(session.id, (prev) => {
                            const updated = [...prev];
                            const last = updated[updated.length - 1];
                            if (last?.role === "assistant") {
                                updated[updated.length - 1] = {
                                    ...last,
                                    annotations: incoming,
                                };
                            }
                            return updated;
                        });
                        continue;
                    }
                } catch {
                    /* skip malformed protocol event */
                }
            }

            chatSession.finish(session.id, "complete");
        } catch (err: unknown) {
            const isAbort = err instanceof Error && err.name === "AbortError";
            chatSession.finish(
                session.id,
                isAbort ? "aborted" : "failed",
            );
        }
    }

    // ---- render ----

    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    const lastAssistantIdx = messages
        .map((m) => m.role)
        .lastIndexOf("assistant");

    return (
        <div
            style={
                {
                    "--tr-chat-panel-width": `${panelWidth}px`,
                } as CSSProperties
            }
            className={cn(
                "flex flex-col relative",
                // Mobile: replaces the table, filling the row minus margins.
                // md+: fixed width beside the table, top-aligned with it
                // (below the toolbar).
                "flex-1 min-w-0 mx-3 mb-3 md:flex-none md:w-[var(--tr-chat-panel-width)] md:mt-12 md:-ml-4 md:mr-6",
                LIQUID_PANEL_SURFACE_CLASS,
                "overflow-hidden",
            )}
        >
            {/* Resize handle */}
            <div
                onMouseDown={(e) => {
                    e.preventDefault();
                    resizeStartRef.current = { x: e.clientX, width: panelWidth };
                    setIsResizing(true);
                }}
                className={`absolute top-0 left-0 h-full w-1 cursor-col-resize z-20 transition-colors hidden md:block ${
                    isResizing
                        ? "bg-blue-400/70"
                        : "bg-transparent hover:bg-blue-400/70"
                }`}
            />
            {/* Header — fixed, overlaid on top of the messages */}
            <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between gap-2 px-2 py-2">
                {/* Title pill — opens chat history */}
                <div ref={historyRef} className="relative shrink min-w-0">
                    <div className={cn(HEADER_PILL_CLASS, "min-w-0")}>
                        <button
                            onClick={() => setHistoryOpen((v) => !v)}
                            title="Chat history"
                            className={`flex h-5 min-w-0 items-center gap-1 rounded-full px-1.5 text-gray-700 transition-colors ${APP_SURFACE_HOVER_CLASS}`}
                        >
                            <span className="min-w-0 truncate text-xs font-medium">
                                {currentChatTitle ?? "New chat"}
                            </span>
                            <ChevronDown
                                className={cn(
                                    "h-3 w-3 shrink-0 text-gray-400 transition-transform duration-200",
                                    historyOpen && "rotate-180",
                                )}
                            />
                        </button>
                    </div>
                    {historyOpen && (
                        <LiquidDropdownSurface className="absolute top-full left-0 z-50 mt-2 w-64 overflow-hidden">
                            <HistoryDropdown
                                chats={chats}
                                currentChatId={currentChatId}
                                onLoad={handleLoadChat}
                                onRename={handleRenameChat}
                                onDelete={handleDeleteChat}
                            />
                        </LiquidDropdownSurface>
                    )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                    {/* New chat circle — only once a chat has started */}
                    {messages.length > 0 && (
                        <div className={cn(HEADER_PILL_CLASS, "px-0.5")}>
                            <button
                                onClick={handleNewChat}
                                title="New chat"
                                className={HEADER_PILL_BUTTON_CLASS}
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    )}
                    {/* Close circle */}
                    <div className={cn(HEADER_PILL_CLASS, "px-0.5")}>
                        <button
                            onClick={onClose}
                            title="Close"
                            className={HEADER_PILL_BUTTON_CLASS}
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Messages */}
            <div
                ref={messagesContainerRef}
                className="flex-1 overflow-y-auto px-4 pt-12 flex flex-col"
                style={{ paddingBottom: Math.ceil(inputHeight + 16) }}
            >
                {isLoadingMessages && (
                    <div className="flex flex-col gap-4">
                        <div className="flex justify-end">
                            <div className="bg-gray-100 rounded-2xl p-3 w-3/5">
                                <div className="h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                            </div>
                        </div>
                        <div className="space-y-2">
                            {[1, 2, 3, 4].map((i) => (
                                <div
                                    key={i}
                                    className={`h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-5/6" : i === 4 ? "w-4/6" : "w-full"}`}
                                />
                            ))}
                        </div>
                    </div>
                )}
                {messages.length > 0 && (
                    <div
                        className="flex flex-col gap-4 transition-opacity duration-150"
                        style={{ opacity: messagesVisible ? 1 : 0 }}
                    >
                        {messages.map((msg, i) => (
                            <div
                                key={i}
                                ref={
                                    i === lastUserIdx
                                        ? latestUserMessageRef
                                        : null
                                }
                                style={
                                    i === lastAssistantIdx
                                        ? { minHeight }
                                        : undefined
                                }
                            >
                                <MessageBubble
                                    msg={msg}
                                    onCitationClick={onCitationClick}
                                />
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* Top blur overlay — messages fade out under the header */}
            <div className="pointer-events-none absolute top-0 left-0 right-2 z-[5] h-10 backdrop-blur-2xl bg-gradient-to-b from-white/80 to-transparent [mask-image:linear-gradient(to_bottom,black_65%,transparent)]" />

            {/* Bottom blur overlay — messages fade out under the input */}
            <div className="pointer-events-none absolute bottom-0 left-0 right-2 z-[5] h-32 backdrop-blur-2xl bg-gradient-to-t from-white/80 to-transparent [mask-image:linear-gradient(to_top,black_65%,transparent)]" />

            {/* Input */}
            <TRChatInput
                isLoading={isLoading}
                onSubmit={handleSubmit}
                onCancel={handleCancel}
                model={currentModel}
                onModelChange={(id) =>
                    updateModelPreference("tabularModel", id)
                }
                apiKeys={apiKeys}
                onHeightChange={setInputHeight}
            />

            <ApiKeyMissingPopup
                open={apiKeyModalProvider !== null}
                provider={apiKeyModalProvider}
                onClose={() => setApiKeyModalProvider(null)}
            />
        </div>
    );
}
