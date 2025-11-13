// modules/renderer/animation.js

// --- CDN URL Mapping ---
// Maps common CDN URLs to local vendor paths
const CDN_TO_LOCAL_MAP = {
    // Three.js CDN patterns (主程序在根目录，不需要 ../)
    'https://cdnjs.cloudflare.com/ajax/libs/three.js': 'vendor/three.min.js',
    'https://cdn.jsdelivr.net/npm/three': 'vendor/three.min.js',
    'https://unpkg.com/three': 'vendor/three.min.js',
    
    // Anime.js CDN patterns
    'https://cdnjs.cloudflare.com/ajax/libs/animejs': 'vendor/anime.min.js',
    'https://cdn.jsdelivr.net/npm/animejs': 'vendor/anime.min.js',
    'https://unpkg.com/animejs': 'vendor/anime.min.js',
};

/**
 * Replaces CDN URLs in script content with local vendor paths
 * @param {string} scriptContent - The script text content
 * @returns {string} The processed script content with local paths
 */
function replaceCdnUrls(scriptContent) {
    if (!scriptContent || typeof scriptContent !== 'string') {
        return scriptContent;
    }
    
    let processed = scriptContent;
    
    // Replace each CDN pattern with its local equivalent
    for (const [cdnPattern, localPath] of Object.entries(CDN_TO_LOCAL_MAP)) {
        // Match the CDN URL with any version number and file extension
        // Example: https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
        const regex = new RegExp(
            cdnPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\'"`\\s]*',
            'g'
        );
        processed = processed.replace(regex, localPath);
    }
    
    return processed;
}

// --- Resource Tracking ---
// Key: The .md-content HTMLElement of a message.
// Value: An array of cleanup objects for Three.js instances within that message.
const trackedThreeInstances = new Map();
let isThreePatched = false;

/**
 * Monkey-patches the THREE.WebGLRenderer to intercept its creation,
 * allowing us to track and manage every instance automatically.
 */
function patchThreeJS() {
    if (isThreePatched || !window.THREE || !window.THREE.WebGLRenderer) return;

    const OriginalWebGLRenderer = window.THREE.WebGLRenderer;

    window.THREE.WebGLRenderer = function(...args) {
        const renderer = new OriginalWebGLRenderer(...args);

        // Intercept the render method to capture the scene
        const originalRender = renderer.render;
        let associatedScene = null;

        renderer.render = function(scene, camera) {
            if (scene && !associatedScene) {
                associatedScene = scene;
            }
            return originalRender.call(this, scene, camera);
        };

        // Use a MutationObserver to wait for the canvas to be added to the DOM
        const observer = new MutationObserver(() => {
            if (document.body.contains(renderer.domElement)) {
                const contentDiv = renderer.domElement.closest('.md-content');
                if (contentDiv) {
                    if (!trackedThreeInstances.has(contentDiv)) {
                        trackedThreeInstances.set(contentDiv, []);
                    }
                    const cleanupRecord = {
                        renderer,
                        getScene: () => associatedScene, // Use a getter to get the scene lazily
                        // We don't track animationFrameId or resizeObserver from AI scripts,
                        // as we can't reliably capture them. Cleanup will focus on the renderer and scene.
                    };
                    trackedThreeInstances.get(contentDiv).push(cleanupRecord);
                    console.log('[Three.js Patch] Tracked new renderer instance.', cleanupRecord);
                }
                observer.disconnect(); // Stop observing once attached and tracked
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });

        return renderer;
    };

    isThreePatched = true;
    console.log('[Three.js Patch] THREE.WebGLRenderer has been patched for resource tracking.');
}


/**
 * Finds and executes script tags, and initializes Three.js scenes within a given HTML element.
 * @param {HTMLElement} containerElement - The element to search for dynamic content within.
 */
export function processAnimationsInContent(containerElement) {
    if (!containerElement) return;

    // --- 1. Patch Three.js if not already done ---
    patchThreeJS();

    // --- 2. Process script tags with run-once protection ---
    const scripts = Array.from(containerElement.querySelectorAll('script'));
    scripts.forEach(oldScript => {
        // If script has already been executed for this element, skip it.
        if (oldScript.dataset.vcpExecuted === 'true') {
            return;
        }

        if (oldScript.type && oldScript.type !== 'text/javascript' && oldScript.type !== 'application/javascript') {
            return;
        }
        
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value));
        
        // 🟢 关键修复：替换 CDN 链接为本地路径
        const originalContent = oldScript.textContent;
        const processedContent = replaceCdnUrls(originalContent);
        
        if (processedContent !== originalContent) {
            console.log('[Animation] Replaced CDN URLs with local paths in script');
        }
        
        newScript.textContent = processedContent;
        
        if (oldScript.parentNode) {
            oldScript.parentNode.replaceChild(newScript, oldScript);
            // Mark the original script element as executed to prevent re-running.
            oldScript.dataset.vcpExecuted = 'true';
        }
    });
}

/**
 * Cleans up all dynamic resources (anime.js, Three.js) within a given element.
 * This should be called before the element is removed from the DOM.
 * @param {HTMLElement} contentDiv - The .md-content div of the message being removed.
 */
export function cleanupAnimationsInContent(contentDiv) {
    if (!contentDiv) return;

    // --- 1. Clean up anime.js instances ---
    if (window.anime) {
        const animatedElements = contentDiv.querySelectorAll('*');
        if (animatedElements.length > 0) {
            anime.remove(animatedElements);
        }
    }

    // --- 2. Clean up ALL tracked Three.js instances within this contentDiv ---
    if (trackedThreeInstances.has(contentDiv)) {
        const instancesToClean = trackedThreeInstances.get(contentDiv);
        console.log(`[Cleanup] Cleaning up ${instancesToClean.length} Three.js instance(s).`);

        instancesToClean.forEach(instance => {
            const scene = instance.getScene(); // Get the scene at cleanup time
            if (scene) {
                scene.traverse(object => {
                    if (object.isMesh) {
                        if (object.geometry) object.geometry.dispose();
                        if (object.material) {
                            if (Array.isArray(object.material)) {
                                object.material.forEach(material => material.dispose());
                            } else if (object.material.dispose) {
                                object.material.dispose();
                            }
                        }
                    }
                });
            }
            
            if (instance.renderer) {
                // Force context loss and dispose
                const gl = instance.renderer.getContext();
                if (gl && gl.getExtension('WEBGL_lose_context')) {
                    gl.getExtension('WEBGL_lose_context').loseContext();
                }
                instance.renderer.dispose();
            }
        });

        // Remove the entry from our tracking map
        trackedThreeInstances.delete(contentDiv);
    }
}

// Note: The simple animateMessageIn/Out functions do not create persistent resources
// and therefore do not need explicit cleanup beyond what anime.remove() already does.
export function animateMessageIn(messageItem) {
    if (!window.anime) return;
    messageItem.style.opacity = 0;
    messageItem.style.transform = 'translateY(20px)';
    anime({
        targets: messageItem,
        opacity: 1,
        translateY: 0,
        duration: 500,
        easing: 'easeOutExpo',
        complete: () => {
            messageItem.style.opacity = '';
            messageItem.style.transform = '';
        }
    });
}

export function animateMessageOut(messageItem, onComplete) {
    if (!window.anime) {
        onComplete();
        return;
    }
    anime({
        targets: messageItem,
        opacity: 0,
        translateY: -20,
        duration: 400,
        easing: 'easeInExpo',
        complete: onComplete
    });
}