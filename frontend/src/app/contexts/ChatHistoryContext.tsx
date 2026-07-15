"use client";

// Local Vera adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/contexts/ChatHistoryContext.tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createVeraAssistantChat,
  deleteVeraAssistantChat,
  listVeraAssistantChats,
  renameVeraAssistantChat,
  type VeraAssistantChat,
} from "@/app/lib/veraAssistantApi";

const INITIAL_CHAT_LIMIT = 20;
const CHAT_LIMIT_INCREMENT = 10;

interface ChatHistoryContextValue {
  chats: VeraAssistantChat[] | null;
  hasMoreChats: boolean;
  loading: boolean;
  error: unknown;
  currentChatId: string | null;
  setCurrentChatId: (chatId: string | null) => void;
  loadChats: () => Promise<void>;
  loadMoreChats: () => void;
  saveChat: (input?: {
    projectId?: string | null;
    modelProfileId?: string | null;
  }) => Promise<string>;
  renameChat: (chatId: string, title: string) => Promise<void>;
  deleteChat: (chatId: string) => Promise<void>;
}

const ChatHistoryContext = createContext<ChatHistoryContextValue | null>(null);

function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

export function ChatHistoryProvider({ children }: { children: ReactNode }) {
  const [chats, setChats] = useState<VeraAssistantChat[] | null>(null);
  const [chatLimit, setChatLimit] = useState(INITIAL_CHAT_LIMIT);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const data = await listVeraAssistantChats(
        { limit: chatLimit + 1 },
        signal,
      );
      if (signal?.aborted || sequence !== requestSequence.current) return;
      setChats(data.slice(0, chatLimit));
      setHasMoreChats(data.length > chatLimit);
    } catch (reason) {
      if (signal?.aborted || isAbort(reason)) return;
      if (sequence !== requestSequence.current) return;
      setChats([]);
      setHasMoreChats(false);
      setError(reason);
    } finally {
      if (!signal?.aborted && sequence === requestSequence.current) {
        setLoading(false);
      }
    }
  }, [chatLimit]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const loadChats = useCallback(async () => {
    await load();
  }, [load]);

  const loadMoreChats = useCallback(() => {
    setChatLimit((current) => current + CHAT_LIMIT_INCREMENT);
  }, []);

  const saveChat = useCallback(
    async (input: {
      projectId?: string | null;
      modelProfileId?: string | null;
    } = {}) => {
      const { id } = await createVeraAssistantChat(input);
      await loadChats();
      setCurrentChatId(id);
      return id;
    },
    [loadChats],
  );

  const renameChat = useCallback(
    async (chatId: string, title: string) => {
      await renameVeraAssistantChat(chatId, title);
      setChats((current) =>
        (current ?? []).map((chat) =>
          chat.id === chatId ? { ...chat, title: title.trim() } : chat,
        ),
      );
    },
    [],
  );

  const deleteChat = useCallback(
    async (chatId: string) => {
      await deleteVeraAssistantChat(chatId);
      setChats((current) =>
        (current ?? []).filter((chat) => chat.id !== chatId),
      );
      setCurrentChatId((current) => (current === chatId ? null : current));
    },
    [],
  );

  const value = useMemo<ChatHistoryContextValue>(
    () => ({
      chats,
      hasMoreChats,
      loading,
      error,
      currentChatId,
      setCurrentChatId,
      loadChats,
      loadMoreChats,
      saveChat,
      renameChat,
      deleteChat,
    }),
    [
      chats,
      currentChatId,
      deleteChat,
      error,
      hasMoreChats,
      loadChats,
      loadMoreChats,
      loading,
      renameChat,
      saveChat,
    ],
  );

  return (
    <ChatHistoryContext.Provider value={value}>
      {children}
    </ChatHistoryContext.Provider>
  );
}

export function useChatHistoryContext(): ChatHistoryContextValue {
  const context = useContext(ChatHistoryContext);
  if (!context) {
    throw new Error(
      "useChatHistoryContext must be used within ChatHistoryProvider",
    );
  }
  return context;
}
