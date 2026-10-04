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
    <div className={cn('mt-3 flex flex-col gap-2 border-border/80 border-t pt-3', className)}>
      {/* 文章导航 */}
      <div className="grid grid-cols-2 gap-1.5">
        {prevPost ? (
          isMounted && (
            <a
              href={localizedPath(routeBuilder(Routes.Post, prevPost), locale)}
              className="series-nav-link"
              title={prevPost.title}
            >
              <span className="series-nav-label">
                <RiArrowLeftSLine className="size-3.5 shrink-0" />
                {t('post.prevPost')}
              </span>
              <span className="series-nav-title">{prevPost.title}</span>
            </a>
          )
        ) : (
          <div />
        )}
        {nextPost ? (
          isMounted && (
            <a
              href={localizedPath(routeBuilder(Routes.Post, nextPost), locale)}
              className="series-nav-link items-end text-right"
              title={nextPost.title}
            >
              <span className="series-nav-label">
                {t('post.nextPost')}
                <RiArrowRightSLine className="size-3.5 shrink-0" />
              </span>
              <span className="series-nav-title">{nextPost.title}</span>
            </a>
          )
        ) : (
          <div />
        )}
      </div>

      {/* 回到顶部和滚到底部 */}
      {isMounted && (
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => window.scrollTo({ top: 0, behavior: scrollBehavior })}
            className="series-nav-action"
            title={t('floating.backToTop')}
            aria-label={t('floating.backToTop')}
          >
            <RiArrowUpSLine className="size-4" />
            {t('floating.backToTop')}
          </button>
          <button
            type="button"
            onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: scrollBehavior })}
            className="series-nav-action"
            title={t('floating.scrollToBottom')}
            aria-label={t('floating.scrollToBottom')}
          >
            <RiArrowDownSLine className="size-4" />
            {t('floating.scrollToBottom')}
          </button>
        </div>
      )}
    </div>
  );
}
