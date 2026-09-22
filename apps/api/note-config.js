// PianoMol 音符显示配置文件
// Developed by MusicMol Team
// 用于自定义音符飘动效果的显示内容

const NoteConfig = {
    // 显示模式: 'text' | 'emoji' | 'image' | 'custom' | 'firework'
    displayMode: 'firework',  // 默认使用彩虹烟花效果
    
    // 烟花模式配置 🎆
    fireworkConfig: {
        // 烟花类型: 'rainbow' | 'single' | 'gradient'
        type: 'rainbow',
        
        // 彩虹颜色序列
        rainbowColors: [
            '#FF0000', // 红
            '#FF7F00', // 橙
            '#FFFF00', // 黄
            '#00FF00', // 绿
            '#00FFFF', // 青
            '#0000FF', // 蓝
            '#8B00FF'  // 紫
        ],
        
        // 烟花粒子数量
        particleCount: 12,
        
        // 粒子大小
        particleSize: 8,
        
        // 爆炸半径
        explosionRadius: 50,
        
        // 粒子拖尾效果
        trail: true,
        
        // 闪烁效果
        sparkle: true,
        
        // 二次爆炸
        secondBurst: false,
        
        // 显示音符名称
        showNoteName: true,
        
        // 音符名称样式
        noteNameStyle: {
            fontSize: '1.8rem',
            fontWeight: 'bold',
            color: 'rainbow', // 'rainbow' 或具体颜色
            glow: true
        }
    },
    
    // 文本模式配置
    textConfig: {
        // 显示内容: 'noteName' | 'custom'
        content: 'noteName',  // 'noteName' 显示音符名称如 C4, D#5
        
        // 自定义文本列表 (当content为'custom'时使用)
        customTexts: ['♪', '♫', '♬', '♩', '♭', '♯', '🎵', '🎶'],
        
        // 字体大小
        fontSize: '2rem',
        
        // 字体粗细
        fontWeight: 'bold',
        
        // 颜色模式: 'random' | 'fixed' | 'gradient'
        colorMode: 'random',
        
        // 随机颜色池 (当colorMode为'random'时使用)
        colors: ['#3e2723', '#5d4037', '#6d4c41', '#8d6e63', '#a1887f', '#795548'],
        
        // 固定颜色 (当colorMode为'fixed'时使用)
        fixedColor: '#5d4037',
        
        // 渐变颜色 (当colorMode为'gradient'时使用)
        gradientColors: ['#3e2723', '#8d6e63']
    },
    
    // Emoji模式配置
    emojiConfig: {
        // Emoji列表
        emojis: ['🎹', '🎵', '🎶', '🎼', '🎧', '🎤', '🎸', '🎺', '🎻', '🥁', '🎷', '🎯', '⭐', '✨', '💫', '🌟'],
        
        // 是否随机选择
        random: true,
        
        // 大小
        size: '2rem'
    },
    // 图片模式配置
    imageConfig: {
        // 图片路径列表
        images: [
            'assets/note1.png',
            'assets/note2.png',
            'assets/note3.png',
            'assets/note4.png'
        ],
        
        // 是否随机选择
        random: true,
        
        // 图片宽度
        width: '40px',
        
        // 图片高度
        height: '40px',
        
        // 是否保持宽高比
        keepRatio: true
    },
    
    // 自定义HTML模式配置
    customConfig: {
        // 自定义HTML生成函数
        // 参数: noteName (音符名称,如 'C4')
        // 返回: HTML字符串
        generateHTML: function(noteName) {
            return `<div class="custom-note">
                <div class="note-circle">${noteName}</div>
            </div>`;
        },
        
        // 自定义CSS (会被注入到页面中)
        customCSS: `
            .custom-note {
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .note-circle {
                width: 50px;
                height: 50px;
                border-radius: 50%;
                background: linear-gradient(135deg, #5d4037 0%, #8d6e63 100%);
                display: flex;
                align-items: center;
                justify-content: center;
                color: white;
                font-weight: bold;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            }
        `
    },

    // ===== 特殊原子显示配置（用于按音高显示原子 emoji + 名称） =====
    specialAtomConfig: {
        // 是否启用按音高显示原子信息（优先于 displayMode 的默认显示）
        enabled: true,

        // backbone 映射（元素 -> 音高，使用你的电负性规则）
        pitchMapBackbone: {
            'C': 'C5', 'N': 'F5', 'O': 'A5', 'F': 'B5',
            'Cl': 'G5', 'Br': 'E5', 'I': 'E5', 'At': 'E5',
            'S': 'D5', 'Se': 'D5', 'Te': 'D5',
            'P': 'C5', 'As': 'C5', 'B': 'C5', 'Si': 'C5', 'other': 'E6'
        },

        // branch 映射会自动生成（5 -> 4），piano.js 可根据此配置生成

        // 原子 emoji / 简短中文名（可按需扩展）
        atomEmoji: {
            'C': '⚪', 'N': '🔵', 'O': '🔴', 'F': '🟢',
            'Cl': '🟩', 'Br': '🟤', 'I': '🟣', 'At': '⚫',
            'S': '🟨', 'Se': '🔶', 'Te': '🔷',
            'P': '🟠', 'As': '🟪', 'B': '🔸', 'Si': '⬛', 'other': '⚛️'
        },

        atomName: {
            'C': '碳', 'N': '氮', 'O': '氧', 'F': '氟',
            'Cl': '氯', 'Br': '溴', 'I': '碘', 'At': '砹',
            'S': '硫', 'Se': '硒', 'Te': '碲',
            'P': '磷', 'As': '砷', 'B': '硼', 'Si': '硅', 'other': '其他'
        },

        // 目标音高范围（按音名精确匹配），这里列出 C4..B5 以及 E6
        targetPitches: ['C4','D4','E4','F4','G4','A4','B4',
                        'C5','D5','E5','F5','G5','A5','B5',
                        'E6']
    },
    
    // WebGL 三维飘动层（musicmol-fx3d.js + Three.js）
    webGL3D: {
        enabled: true,
        /** 为 true 时由 WebGL 负责主粒子，不再叠加 DOM .note-particle（避免重复） */
        skipDomParticles: true,
    },

    // 动画配置
    animationConfig: {
        // 动画持续时间 (秒)
        duration: 4,
        
        // 起始位置 (相对于键盘顶部, 负值表示上方)
        startY: -20,        // 从琴键上方20px开始
        
        // 结束位置 (相对于键盘顶部, 负值表示上方)
        endY: -500,         // 飘到上方500px
        
        // 缩放范围
        scaleStart: 0.9,
        scaleEnd: 1.25,
        
        // 模糊范围 (px)
        blurStart: 0,
        blurEnd: 2.5,
        
        // 透明度范围
        opacityStart: 0.95,
        opacityEnd: 0,
        
        // 水平漂移 (px, 正值向右, 负值向左, 0表示无漂移)
        horizontalDrift: 0,
        
        // 旋转角度 (度, 0表示无旋转)
        rotation: 0
    },
    
    // 水花效果配置
    splashConfig: {
        // 是否启用水花效果
        enabled: true,
        
        // 粒子数量
        particleCount: 6,
        
        // 粒子大小 (px)
        particleSize: 6,
        
        // 扩散距离 (px)
        spreadDistance: 35,
        
        // 动画时长 (秒)
        duration: 0.8,
        
        // 粒子颜色 (使用音符颜色)
        useNoteColor: true,
        
        // 固定颜色 (当useNoteColor为false时使用)
        fixedColor: '#5d4037'
    }
};

// 导出配置
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NoteConfig;
}
