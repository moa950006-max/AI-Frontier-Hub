import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Search, RefreshCw, ExternalLink, ChevronLeft, ChevronRight, Clock, Newspaper, Globe, Languages } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { zhCN, enUS } from "date-fns/locale";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { GoogleGenAI } from "@google/genai";
import { io } from "socket.io-client";

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface NewsItem {
  id: string;
  title: string;
  link: string;
  pubDate: string;
  content: string;
  source: string;
  category: string;
  summary: string;
  imageUrl: string;
  translatedTitle?: string;
  translatedSummary?: string;
}

type Language = "en" | "zh";

const TRANSLATIONS = {
  en: {
    title: "AI Frontier Hub",
    searchPlaceholder: "Search AI news...",
    refresh: "Refresh news",
    readFull: "Read Full Story",
    details: "Details",
    noNews: "No news found matching your criteria.",
    clearFilters: "Clear all filters",
    footer: "© 2026 AI Frontier News Hub. Real-time AI insights powered by global feeds.",
    privacy: "Privacy",
    terms: "Terms",
    contact: "Contact",
    ago: "ago",
    via: "via",
    all: "All"
  },
  zh: {
    title: "AI 前沿动态",
    searchPlaceholder: "搜索 AI 新闻...",
    refresh: "刷新新闻",
    readFull: "阅读全文",
    details: "查看详情",
    noNews: "未找到匹配的新闻。",
    clearFilters: "清除所有筛选",
    footer: "© 2026 AI 前沿动态平台。实时 AI 资讯，汇聚全球动态。",
    privacy: "隐私政策",
    terms: "使用条款",
    contact: "联系我们",
    ago: "前",
    via: "来源",
    all: "全部"
  }
};

export default function App() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [carouselIndex, setCarouselIndex] = useState(0);
  const [lang, setLang] = useState<Language>("en");
  const [translating, setTranslating] = useState(false);
  const [now, setNow] = useState(new Date());

  const t = TRANSLATIONS[lang];

  const fetchNews = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/news?category=${selectedCategory}&search=${searchQuery}`);
      const data = await res.json();
      setNews(data);
    } catch (err) {
      console.error("Failed to fetch news:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedCategory, searchQuery]);

  useEffect(() => {
    fetch("/api/categories")
      .then(res => res.json())
      .then(setCategories);
  }, []);

  useEffect(() => {
    fetchNews();
  }, [fetchNews]);

  // Real-time updates via WebSockets
  useEffect(() => {
    const socket = io();
    
    socket.on("connect", () => {
      console.log("Connected to real-time news server");
    });

    socket.on("news-updated", (data) => {
      console.log("Real-time update received:", data);
      // Refresh news when server notifies of new items
      fetchNews();
    });

    return () => {
      socket.disconnect();
    };
  }, [fetchNews]);

  // Translation Logic
  useEffect(() => {
    if (lang === "zh" && news.length > 0 && !translating) {
      const untranslated = news.filter(n => !n.translatedTitle);
      if (untranslated.length > 0) {
        translateBatch(untranslated.slice(0, 10)); // Translate in small batches
      }
    }
  }, [lang, news]);

  const translateBatch = async (items: NewsItem[]) => {
    setTranslating(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const prompt = `Translate the following AI news items into Chinese. Return ONLY a JSON array of objects with 'id', 'title', and 'summary' fields.
      Items: ${JSON.stringify(items.map(i => ({ id: i.id, title: i.title, summary: i.summary })))}`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { responseMimeType: "application/json" }
      });

      const translatedData = JSON.parse(response.text);
      setNews(prev => prev.map(item => {
        const found = translatedData.find((t: any) => t.id === item.id);
        if (found) {
          return { ...item, translatedTitle: found.title, translatedSummary: found.summary };
        }
        return item;
      }));
    } catch (err) {
      console.error("Translation error:", err);
    } finally {
      setTranslating(false);
    }
  };

  // Update 'now' every minute to refresh 'time ago' labels
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  const carouselNews = news.slice(0, 5);

  const handleNext = useCallback(() => {
    if (carouselNews.length === 0) return;
    setCarouselIndex(prev => (prev + 1) % carouselNews.length);
  }, [carouselNews.length]);

  const handlePrev = useCallback(() => {
    if (carouselNews.length === 0) return;
    setCarouselIndex(prev => (prev - 1 + carouselNews.length) % carouselNews.length);
  }, [carouselNews.length]);

  // Carousel Auto-scroll
  useEffect(() => {
    if (news.length === 0) return;
    const interval = setInterval(handleNext, 5000);
    return () => clearInterval(interval);
  }, [news, handleNext]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans selection:bg-blue-100">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Newspaper className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 hidden sm:block">
              {t.title}
            </h1>
          </div>

          <div className="flex-1 max-w-md relative group">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
            <input
              type="text"
              placeholder={t.searchPlaceholder}
              className="w-full bg-slate-100 border-none rounded-full py-2 pl-10 pr-4 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-all placeholder:text-slate-400"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setLang(lang === "en" ? "zh" : "en")}
              className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-slate-100 hover:bg-slate-200 transition-colors text-sm font-medium text-slate-600"
            >
              <Globe className="w-4 h-4" />
              {lang === "en" ? "EN" : "中文"}
            </button>
            <button 
              onClick={fetchNews}
              className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-500 hover:text-blue-600"
              title={t.refresh}
            >
              <RefreshCw className={cn("w-5 h-5", loading && "animate-spin")} />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 space-y-12">
        {/* Hero Carousel */}
        {!searchQuery && selectedCategory === "All" && carouselNews.length > 0 && (
          <section className="relative h-[500px] rounded-3xl overflow-hidden group shadow-2xl border border-slate-200">
            <AnimatePresence mode="wait">
              <motion.div
                key={carouselIndex}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.5, ease: "easeInOut" }}
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                onDragEnd={(_, info) => {
                  const swipeThreshold = 50;
                  if (info.offset.x > swipeThreshold) handlePrev();
                  else if (info.offset.x < -swipeThreshold) handleNext();
                }}
                className="absolute inset-0 cursor-grab active:cursor-grabbing"
              >
                {/* Background Image */}
                <img
                  src={carouselNews[carouselIndex].imageUrl}
                  alt=""
                  className="w-full h-full object-cover pointer-events-none"
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${encodeURIComponent(carouselNews[carouselIndex].id)}/1200/600`;
                  }}
                />
                
                {/* Gradient Overlay for Readability */}
                <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px] z-10" />
                <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-black/60 z-10" />

                {/* Content Overlay - Centered with consistent padding */}
                <div className="absolute inset-0 z-20 p-12 md:p-24 flex flex-col items-center justify-center text-center space-y-6">
                  <motion.div 
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.2 }}
                    className="space-y-4 max-w-3xl"
                  >
                    <div className="flex flex-wrap items-center justify-center gap-2 md:gap-3">
                      <span className="px-3 py-1 md:px-4 md:py-1.5 bg-blue-600/90 text-white text-[10px] md:text-xs font-bold rounded-full uppercase tracking-widest shadow-lg shadow-blue-500/20 backdrop-blur-sm">
                        {carouselNews[carouselIndex].category}
                      </span>
                      <span className="text-white/80 text-[10px] md:text-sm font-medium flex items-center gap-1 md:gap-1.5 backdrop-blur-md bg-white/10 border border-white/10 px-2.5 py-1 md:px-3 md:py-1 rounded-full">
                        <Clock className="w-3.5 h-3.5 md:w-4 h-4" />
                        {formatDistanceToNow(new Date(carouselNews[carouselIndex].pubDate), { locale: lang === 'zh' ? zhCN : enUS })} {t.ago}
                      </span>
                    </div>
                    
                    {/* Fixed height container for headline to prevent layout shifts */}
                    <div className="h-[80px] md:h-[120px] flex items-center justify-center overflow-hidden">
                      <h2 className="text-2xl md:text-5xl font-extrabold leading-tight text-white drop-shadow-lg line-clamp-2">
                        {lang === 'zh' ? (carouselNews[carouselIndex].translatedTitle || carouselNews[carouselIndex].title) : carouselNews[carouselIndex].title}
                      </h2>
                    </div>

                    <div className="h-[60px] md:h-[80px] flex items-center justify-center overflow-hidden">
                      <p className="text-white/90 text-sm md:text-xl line-clamp-2 md:line-clamp-3 font-medium drop-shadow-md">
                        {lang === 'zh' ? (carouselNews[carouselIndex].translatedSummary || carouselNews[carouselIndex].summary) : carouselNews[carouselIndex].summary}
                      </p>
                    </div>
                  </motion.div>

                  <motion.div
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.4 }}
                  >
                    <a
                      href={carouselNews[carouselIndex].link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-8 py-3.5 bg-white text-blue-600 text-sm font-bold rounded-xl hover:bg-blue-600 hover:text-white transition-all shadow-xl hover:shadow-blue-500/40 group/btn"
                    >
                      {t.readFull}
                      <ExternalLink className="w-4 h-4 group-hover/btn:translate-x-0.5 group-hover/btn:-translate-y-0.5 transition-transform" />
                    </a>
                  </motion.div>
                </div>
              </motion.div>
            </AnimatePresence>

            {/* Navigation Arrows - iOS 16 Style Glassmorphism (Visible on all devices) */}
            <button
              onClick={handlePrev}
              className="absolute left-2 md:left-4 top-1/2 -translate-y-1/2 z-30 p-2 md:p-3 bg-white/5 backdrop-blur-xl rounded-full hover:bg-white/15 shadow-xl transition-all border border-white/10 text-white/70 hover:text-white group/nav flex"
              aria-label="Previous slide"
            >
              <ChevronLeft className="w-5 h-5 md:w-6 md:h-6 group-hover/nav:-translate-x-0.5 transition-transform" />
            </button>
            <button
              onClick={handleNext}
              className="absolute right-2 md:right-4 top-1/2 -translate-y-1/2 z-30 p-2 md:p-3 bg-white/5 backdrop-blur-xl rounded-full hover:bg-white/15 shadow-xl transition-all border border-white/10 text-white/70 hover:text-white group/nav flex"
              aria-label="Next slide"
            >
              <ChevronRight className="w-5 h-5 md:w-6 md:h-6 group-hover/nav:translate-x-0.5 transition-transform" />
            </button>
          </section>
        )}

        {/* Category Filters */}
        <div className="flex items-center gap-2 overflow-x-auto pb-2 no-scrollbar">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={cn(
                "px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all border",
                selectedCategory === cat
                  ? "bg-blue-600 border-blue-500 text-white shadow-lg shadow-blue-500/20"
                  : "bg-white border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-900"
              )}
            >
              {cat === "All" ? t.all : cat}
            </button>
          ))}
        </div>

        {/* News Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {loading ? (
            Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-80 bg-white rounded-2xl animate-pulse border border-slate-200 shadow-sm" />
            ))
          ) : news.length > 0 ? (
            news.map((item, idx) => (
              <motion.article
                key={item.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                className="group bg-white rounded-2xl border border-slate-200 hover:border-blue-300 transition-all hover:shadow-xl overflow-hidden flex flex-col"
              >
                <div className="h-48 overflow-hidden relative bg-slate-100">
                  <img 
                    src={item.imageUrl} 
                    alt="" 
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = `https://picsum.photos/seed/${encodeURIComponent(item.id)}/800/450`;
                    }}
                  />
                  <div className="absolute top-4 left-4">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-blue-600 px-2 py-1 bg-white/90 backdrop-blur-sm rounded shadow-sm">
                      {item.category}
                    </span>
                  </div>
                </div>
                <div className="p-6 space-y-3 flex-1">
                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDistanceToNow(new Date(item.pubDate), { locale: lang === 'zh' ? zhCN : enUS })} {t.ago}
                    </span>
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 group-hover:text-blue-600 transition-colors line-clamp-2 leading-snug">
                    {lang === 'zh' ? (item.translatedTitle || item.title) : item.title}
                  </h3>
                  <p className="text-slate-500 text-sm line-clamp-3 leading-relaxed">
                    {lang === 'zh' ? (item.translatedSummary || item.summary) : item.summary}
                  </p>
                </div>
                <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-400 italic">
                    {t.via} {item.source}
                  </span>
                  <a
                    href={item.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:text-blue-700 text-sm font-bold flex items-center gap-1"
                  >
                    {t.details}
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </motion.article>
            ))
          ) : (
            <div className="col-span-full py-20 text-center space-y-4">
              <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto">
                <Search className="w-8 h-8 text-slate-300" />
              </div>
              <p className="text-slate-500 text-lg">{t.noNews}</p>
              <button 
                onClick={() => { setSearchQuery(""); setSelectedCategory("All"); }}
                className="text-blue-600 hover:underline font-medium"
              >
                {t.clearFilters}
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="border-t border-slate-200 py-12 bg-white mt-20">
        <div className="max-w-7xl mx-auto px-4 flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center">
              <Newspaper className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-slate-900">{t.title}</span>
          </div>
          <p className="text-slate-400 text-sm">
            {t.footer}
          </p>
          <div className="flex gap-6 text-slate-400 text-sm">
            <a href="#" className="hover:text-blue-600 transition-colors">{t.privacy}</a>
            <a href="#" className="hover:text-blue-600 transition-colors">{t.terms}</a>
            <a href="#" className="hover:text-blue-600 transition-colors">{t.contact}</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
