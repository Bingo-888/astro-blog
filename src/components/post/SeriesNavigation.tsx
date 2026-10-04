/**
 * SeriesNavigation - 系列文章上一篇/下一篇导航
 */
import { Routes } from '@constants/router';
import { useIsMounted } from '@hooks/useIsMounted';
import { useTranslation } from '@hooks/useTranslation';
import { routeBuilder } from '@lib/route';
import { cn } from '@lib/utils';
import { RiArrowDownSLine, RiArrowLeftSLine, RiArrowRightSLine, RiArrowUpSLine } from 'react-icons/ri';
import { localizedPath } from '@/i18n';
import type { PostRef } from '@/types/blog';

interface SeriesNavigationProps {
  prevPost?: PostRef | null;
  nextPost?: PostRef | null;
  className?: string;
  locale?: string;
}

export function SeriesNavigation({ prevPost, nextPost, className, locale }: SeriesNavigationProps) {
  const isMounted = useIsMounted();
  const { t } = useTranslation(locale);

  if (!prevPost && !nextPost) {
    return null;
  }

  const scrollBehavior: ScrollBehavior = 'smooth';

  return (
    <div className={cn('series-nav', className)}>
      {isMounted && (
        <>
          {prevPost && (
            <a
              href={localizedPath(routeBuilder(Routes.Post, prevPost), locale)}
              className="series-nav-link"
              data-dir="prev"
              title={prevPost.title}
            >
              <RiArrowLeftSLine className="series-nav-icon" />
              <span className="series-nav-text">
                <span className="series-nav-label">{t('post.prevPost')}</span>
                <span className="series-nav-title">{prevPost.title}</span>
              </span>
            </a>
          )}
          {nextPost && (
            <a
              href={localizedPath(routeBuilder(Routes.Post, nextPost), locale)}
              className="series-nav-link"
              data-dir="next"
              title={nextPost.title}
            >
              <RiArrowRightSLine className="series-nav-icon" />
              <span className="series-nav-text">
                <span className="series-nav-label">{t('post.nextPost')}</span>
                <span className="series-nav-title">{nextPost.title}</span>
              </span>
            </a>
          )}
          {/* 桌面端由浮动按钮组提供；抽屉打开时浮动按钮组隐藏，这里补上 */}
          <div className="series-nav-actions">
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: scrollBehavior })}
              className="series-nav-action"
              aria-label={t('floating.backToTop')}
            >
              <RiArrowUpSLine className="size-4" />
              {t('floating.backToTop')}
            </button>
            <button
              type="button"
              onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: scrollBehavior })}
              className="series-nav-action"
              aria-label={t('floating.scrollToBottom')}
            >
              <RiArrowDownSLine className="size-4" />
              {t('floating.scrollToBottom')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
