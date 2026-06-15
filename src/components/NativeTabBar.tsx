/**
 * 네이티브 하단 탭바 (N4, D1) — WebView "밖 형제 뷰"(오버레이 아님).
 * 탭 터치 → onTabPress(NAVIGATE 발신). 활성 하이라이트는 ROUTE_CHANGED(웹 소유) 기준으로만 갱신.
 * 아이콘 자산이 앱에 없어 1차는 라벨+점 인디케이터(웹 AppBar 라벨과 동일). 아이콘 도입은 후속.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ActiveTab } from '../bridge/protocol';

export const TAB_BAR_HEIGHT = 56;

export const TABS: { key: ActiveTab; label: string; path: string }[] = [
  { key: 'home', label: '홈', path: '/' },
  { key: 'map', label: '지도', path: '/map' },
  { key: 'community', label: '커뮤니티', path: '/community' },
  { key: 'my', label: '마이', path: '/mypage' },
];

interface NativeTabBarProps {
  activeTab: ActiveTab | null;
  bottomInset: number;
  onTabPress: (tab: ActiveTab, path: string) => void;
}

const NativeTabBar = ({ activeTab, bottomInset, onTabPress }: NativeTabBarProps) => {
  return (
    <View
      style={[styles.bar, { paddingBottom: bottomInset }]}
      accessibilityRole="tablist"
    >
      <View style={styles.row}>
        {TABS.map((tab) => {
          const active = tab.key === activeTab;
          return (
            <Pressable
              key={tab.key}
              style={styles.item}
              onPress={() => onTabPress(tab.key, tab.path)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`${tab.label} 탭`}
            >
              <View style={[styles.dot, active && styles.dotActive]} />
              <Text style={[styles.label, active && styles.labelActive]}>
                {tab.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#F4F4F5',
  },
  row: {
    height: TAB_BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 12,
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#CFCFCF',
  },
  dotActive: {
    backgroundColor: '#111111',
  },
  label: {
    fontSize: 12,
    lineHeight: 12,
    color: '#CFCFCF',
  },
  labelActive: {
    color: '#111111',
  },
});

export default NativeTabBar;
