<?php
/**
 * The Store module — WooCommerce and content actions over one signed
 * endpoint, so the operator can run the shop from their phone through
 * Morpheus.
 *
 *   POST /wp-json/morpheus/v1/store   { "action": "...", "data": { ... } }
 *
 * Signed the same way as /deploy (HMAC-SHA256 over the raw body, verified
 * by Morpheus_REST::verified_body). Runs inside WordPress, so it uses
 * WooCommerce's own PHP API directly — no WC REST keys, transactional.
 *
 * Actions:
 *   context         — categories, brands, currency, product count (feeds
 *                     the STORE panel's dropdowns)
 *   list_products   — recent products (id, name, sku, price, stock, status)
 *   get_product     — one product by id or sku
 *   create_product  — new simple product (draft by default)
 *   update_product  — partial update by id or sku (status too: publish ↔ draft)
 *   set_stock       — quantity by id or sku
 *   delete_product  — trash by id or sku (force:true bypasses the trash)
 *   create_post     — a blog post (draft by default)
 *   list_pages      — pages (id, title, slug, status) — no WooCommerce needed
 *   get_page        — one page's full content by id
 *   create_page     — new page (draft by default)
 *   update_page     — partial update by id (title/content/excerpt/status)
 *   delete_page     — trash by id (force:true bypasses the trash)
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Store {

	const BRAND_TAXONOMY = 'product_brand'; // Woodmart / the site's custom "Brand" taxonomy — resolved at runtime

	public static function register_routes() {
		register_rest_route( MORPHEUS_REST_NS, '/store', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle' ),
		) );
	}

	public static function handle( WP_REST_Request $request ) {
		$body = Morpheus_REST::verified_body( $request );
		if ( $body instanceof WP_REST_Response ) {
			return $body;
		}
		$action = isset( $body['action'] ) ? sanitize_key( $body['action'] ) : '';
		$data   = isset( $body['data'] ) && is_array( $body['data'] ) ? $body['data'] : array();

		$product_actions = array( 'context', 'list_products', 'get_product', 'create_product', 'update_product', 'set_stock', 'delete_product' );
		if ( in_array( $action, $product_actions, true ) && ! class_exists( 'WooCommerce' ) ) {
			return Morpheus_REST::err( 'no_woocommerce', 'WooCommerce is not active on this site.', 409 );
		}

		morpheus_log( 'store', array( 'action' => $action ) );

		switch ( $action ) {
			case 'context':        $r = self::context(); break;
			case 'list_products':  $r = self::list_products( $data ); break;
			case 'get_product':    $r = self::get_product( $data ); break;
			case 'create_product': $r = self::create_product( $data ); break;
			case 'update_product': $r = self::update_product( $data ); break;
			case 'set_stock':      $r = self::set_stock( $data ); break;
			case 'delete_product': $r = self::delete_product( $data ); break;
			case 'create_post':    $r = self::create_post( $data ); break;
			case 'list_pages':     $r = self::list_pages( $data ); break;
			case 'get_page':       $r = self::get_page_action( $data ); break;
			case 'create_page':    $r = self::create_page( $data ); break;
			case 'update_page':    $r = self::update_page( $data ); break;
			case 'delete_page':    $r = self::delete_page( $data ); break;
			default:
				return Morpheus_REST::err( 'unknown_action', "Unknown store action: {$action}", 400 );
		}

		if ( is_wp_error( $r ) ) {
			$d = $r->get_error_data();
			$s = is_array( $d ) && isset( $d['status'] ) ? $d['status'] : 422;
			return Morpheus_REST::err( $r->get_error_code(), $r->get_error_message(), $s );
		}

		// A product/post created or changed here won't show on the shop and
		// category archives until their cached HTML is purged — WooCommerce's
		// own save hooks don't always reach page-cache plugins from a REST
		// context. Flush WC's product transients and, when a page cache is
		// present, the whole cached site.
		if ( in_array( $action, array( 'create_product', 'update_product', 'set_stock', 'delete_product', 'create_post', 'create_page', 'update_page', 'delete_page' ), true ) ) {
			self::purge_caches();
		}

		return new WP_REST_Response( array_merge( array( 'ok' => true, 'action' => $action ), $r ), 200 );
	}

	// ── helpers ────────────────────────────────────────────────────────────

	/** Clear WooCommerce product transients + any page cache, so a new/
	 *  changed product appears on the shop and category archives right away. */
	private static function purge_caches() {
		if ( function_exists( 'wc_delete_product_transients' ) ) {
			wc_delete_product_transients();
		}
		if ( class_exists( 'WC_Cache_Helper' ) && method_exists( 'WC_Cache_Helper', 'get_transient_version' ) ) {
			WC_Cache_Helper::get_transient_version( 'product', true );
		}
		// Page-cache plugins — call whatever's present. Each is a no-op if absent.
		if ( function_exists( 'rocket_clean_domain' ) )        { rocket_clean_domain(); }        // WP Rocket
		if ( function_exists( 'w3tc_flush_all' ) )             { w3tc_flush_all(); }             // W3 Total Cache
		if ( function_exists( 'wp_cache_clear_cache' ) )       { wp_cache_clear_cache(); }       // WP Super Cache
		if ( function_exists( 'sg_cachepress_purge_cache' ) )  { sg_cachepress_purge_cache(); }  // SiteGround
		if ( has_action( 'litespeed_purge_all' ) )             { do_action( 'litespeed_purge_all' ); } // LiteSpeed
		if ( function_exists( 'wpo_cache_flush' ) )            { wpo_cache_flush(); }            // WP-Optimize
		wp_cache_flush(); // object cache
		morpheus_log( 'cache_purge', array() );
	}


	/** The site's "Brand" taxonomy — Woodmart registers one; fall back sensibly. */
	private static function brand_taxonomy() {
		foreach ( array( 'product_brand', 'pwb-brand', 'brand', 'yith_product_brand' ) as $t ) {
			if ( taxonomy_exists( $t ) ) {
				return $t;
			}
		}
		return null;
	}

	private static function term_ids( $taxonomy, $names ) {
		$ids = array();
		foreach ( (array) $names as $n ) {
			$n = trim( (string) $n );
			if ( $n === '' ) {
				continue;
			}
			if ( is_numeric( $n ) ) {
				$ids[] = (int) $n;
				continue;
			}
			$term = get_term_by( 'name', $n, $taxonomy ) ?: get_term_by( 'slug', sanitize_title( $n ), $taxonomy );
			if ( ! $term ) {
				$new = wp_insert_term( $n, $taxonomy );
				if ( ! is_wp_error( $new ) ) {
					$ids[] = (int) $new['term_id'];
				}
			} else {
				$ids[] = (int) $term->term_id;
			}
		}
		return array_values( array_unique( $ids ) );
	}

	/** Sideload image URLs → attachment ids. Best effort; a bad URL is skipped. */
	private static function sideload_images( $urls, $post_id ) {
		if ( empty( $urls ) ) {
			return array();
		}
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';
		require_once ABSPATH . 'wp-admin/includes/image.php';
		$ids = array();
		foreach ( (array) $urls as $url ) {
			$url = esc_url_raw( trim( (string) $url ) );
			if ( ! $url || ! preg_match( '#^https?://#i', $url ) ) {
				continue;
			}
			$id = media_sideload_image( $url, $post_id, null, 'id' );
			if ( ! is_wp_error( $id ) ) {
				$ids[] = (int) $id;
			}
		}
		return $ids;
	}

	private static function product_summary( $product ) {
		return array(
			'id'        => $product->get_id(),
			'name'      => $product->get_name(),
			'sku'       => $product->get_sku(),
			'status'    => $product->get_status(),
			'price'     => $product->get_regular_price(),
			'sale'      => $product->get_sale_price(),
			'stock'     => $product->get_manage_stock() ? $product->get_stock_quantity() : null,
			'stock_status' => $product->get_stock_status(),
			'permalink' => get_permalink( $product->get_id() ),
			'edit_url'  => admin_url( 'post.php?post=' . $product->get_id() . '&action=edit' ),
		);
	}

	/** Yoast SEO title + meta description, on whatever post id. No-op (and
	 *  reports unavailable via context.seo_available) when Yoast isn't
	 *  active — the two postmeta keys are Yoast's own, so writing them with
	 *  Yoast off would just be orphaned data nothing reads. */
	private static function set_seo_meta( $post_id, $data ) {
		if ( ! defined( 'WPSEO_VERSION' ) ) {
			return;
		}
		if ( isset( $data['seo_title'] ) ) {
			update_post_meta( $post_id, '_yoast_wpseo_title', sanitize_text_field( $data['seo_title'] ) );
		}
		if ( isset( $data['seo_description'] ) ) {
			update_post_meta( $post_id, '_yoast_wpseo_metadesc', sanitize_text_field( $data['seo_description'] ) );
		}
	}

	private static function seo_meta( $post_id ) {
		if ( ! defined( 'WPSEO_VERSION' ) ) {
			return array( 'seo_title' => '', 'seo_description' => '' );
		}
		return array(
			'seo_title'       => (string) get_post_meta( $post_id, '_yoast_wpseo_title', true ),
			'seo_description' => (string) get_post_meta( $post_id, '_yoast_wpseo_metadesc', true ),
		);
	}

	private static function find_product( $data ) {
		if ( ! empty( $data['id'] ) ) {
			$p = wc_get_product( (int) $data['id'] );
			return $p ?: new WP_Error( 'not_found', 'No product with that id.', array( 'status' => 404 ) );
		}
		if ( ! empty( $data['sku'] ) ) {
			$id = wc_get_product_id_by_sku( sanitize_text_field( $data['sku'] ) );
			$p  = $id ? wc_get_product( $id ) : null;
			return $p ?: new WP_Error( 'not_found', 'No product with that SKU.', array( 'status' => 404 ) );
		}
		return new WP_Error( 'bad_request', 'Pass an id or sku.', array( 'status' => 400 ) );
	}

	// ── actions ────────────────────────────────────────────────────────────

	private static function context() {
		$cats = array();
		foreach ( get_terms( array( 'taxonomy' => 'product_cat', 'hide_empty' => false ) ) as $t ) {
			if ( ! is_wp_error( $t ) ) {
				$cats[] = array( 'id' => $t->term_id, 'name' => $t->name, 'count' => $t->count );
			}
		}
		$brands = array();
		$bt     = self::brand_taxonomy();
		if ( $bt ) {
			foreach ( get_terms( array( 'taxonomy' => $bt, 'hide_empty' => false ) ) as $t ) {
				if ( ! is_wp_error( $t ) ) {
					$brands[] = array( 'id' => $t->term_id, 'name' => $t->name );
				}
			}
		}
		return array(
			'currency'        => get_woocommerce_currency(),
			'currency_symbol' => html_entity_decode( get_woocommerce_currency_symbol() ),
			'categories'      => $cats,
			'brand_taxonomy'  => $bt,
			'brands'          => $brands,
			'product_count'   => (int) wp_count_posts( 'product' )->publish + (int) wp_count_posts( 'product' )->draft,
			'default_status'  => 'draft',
			'seo_available'   => defined( 'WPSEO_VERSION' ),
		);
	}

	private static function list_products( $data ) {
		$q = new WP_Query( array(
			'post_type'      => 'product',
			'post_status'    => isset( $data['status'] ) ? sanitize_key( $data['status'] ) : array( 'publish', 'draft', 'pending' ),
			'posts_per_page' => min( 50, max( 1, (int) ( $data['limit'] ?? 20 ) ) ),
			'orderby'        => 'date',
			'order'          => 'DESC',
			's'              => isset( $data['search'] ) ? sanitize_text_field( $data['search'] ) : '',
		) );
		$out = array();
		foreach ( $q->posts as $post ) {
			$p = wc_get_product( $post->ID );
			if ( $p ) {
				$out[] = self::product_summary( $p );
			}
		}
		return array( 'products' => $out, 'total' => (int) $q->found_posts );
	}

	private static function get_product( $data ) {
		$p = self::find_product( $data );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		$bt     = self::brand_taxonomy();
		$brands = $bt ? wp_get_post_terms( $p->get_id(), $bt, array( 'fields' => 'names' ) ) : array();
		return array( 'product' => array_merge( self::product_summary( $p ), self::seo_meta( $p->get_id() ), array(
			'description'       => $p->get_description(),
			'short_description' => $p->get_short_description(),
			'categories'        => wp_get_post_terms( $p->get_id(), 'product_cat', array( 'fields' => 'names' ) ),
			'brands'            => is_wp_error( $brands ) ? array() : $brands,
			'images'            => array_values( array_filter( array_merge(
				array( wp_get_attachment_url( $p->get_image_id() ) ),
				array_map( 'wp_get_attachment_url', $p->get_gallery_image_ids() )
			) ) ),
		) ) );
	}

	private static function apply_fields( WC_Product $p, $data ) {
		if ( isset( $data['name'] ) )              { $p->set_name( sanitize_text_field( $data['name'] ) ); }
		if ( isset( $data['description'] ) )       { $p->set_description( wp_kses_post( $data['description'] ) ); }
		if ( isset( $data['short_description'] ) ) { $p->set_short_description( wp_kses_post( $data['short_description'] ) ); }
		if ( isset( $data['sku'] ) )               { $p->set_sku( sanitize_text_field( $data['sku'] ) ); }
		if ( isset( $data['regular_price'] ) )     { $p->set_regular_price( (string) wc_format_decimal( $data['regular_price'] ) ); }
		if ( array_key_exists( 'sale_price', $data ) ) {
			$p->set_sale_price( $data['sale_price'] === '' || $data['sale_price'] === null ? '' : (string) wc_format_decimal( $data['sale_price'] ) );
		}
		if ( array_key_exists( 'stock', $data ) ) {
			if ( $data['stock'] === null || $data['stock'] === '' ) {
				$p->set_manage_stock( false );
			} else {
				$p->set_manage_stock( true );
				$p->set_stock_quantity( (int) $data['stock'] );
				$p->set_stock_status( (int) $data['stock'] > 0 ? 'instock' : 'outofstock' );
			}
		}
		if ( isset( $data['status'] ) && in_array( $data['status'], array( 'draft', 'publish', 'pending', 'private' ), true ) ) {
			$p->set_status( $data['status'] );
		}
		if ( isset( $data['categories'] ) ) {
			$p->set_category_ids( self::term_ids( 'product_cat', $data['categories'] ) );
		}
	}

	private static function create_product( $data ) {
		if ( empty( $data['name'] ) ) {
			return new WP_Error( 'bad_request', 'A product name is required.', array( 'status' => 400 ) );
		}
		$p = new WC_Product_Simple();
		if ( ! isset( $data['status'] ) ) {
			$data['status'] = 'draft'; // never auto-publish
		}
		self::apply_fields( $p, $data );
		$id = $p->save();
		if ( ! $id ) {
			return new WP_Error( 'save_failed', 'WooCommerce could not save the product.', array( 'status' => 500 ) );
		}

		$brand = self::brand_taxonomy();
		if ( $brand && ! empty( $data['brand'] ) ) {
			wp_set_object_terms( $id, self::term_ids( $brand, $data['brand'] ), $brand );
		}

		$img_ids = self::sideload_images( $data['images'] ?? array(), $id );
		if ( $img_ids ) {
			$p = wc_get_product( $id );
			$p->set_image_id( array_shift( $img_ids ) );
			if ( $img_ids ) {
				$p->set_gallery_image_ids( $img_ids );
			}
			$p->save();
		}
		self::set_seo_meta( $id, $data );

		return array( 'product' => self::product_summary( wc_get_product( $id ) ), 'created' => true );
	}

	private static function update_product( $data ) {
		$p = self::find_product( $data );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		self::apply_fields( $p, $data );
		$id = $p->save();

		$brand = self::brand_taxonomy();
		if ( $brand && isset( $data['brand'] ) ) {
			wp_set_object_terms( $id, self::term_ids( $brand, $data['brand'] ), $brand );
		}
		$img_ids = self::sideload_images( $data['images'] ?? array(), $id );
		if ( $img_ids ) {
			$p = wc_get_product( $id );
			$gallery = $p->get_gallery_image_ids();
			if ( ! $p->get_image_id() ) {
				$p->set_image_id( array_shift( $img_ids ) );
			}
			$p->set_gallery_image_ids( array_merge( $gallery, $img_ids ) );
			$p->save();
		}
		self::set_seo_meta( $id, $data );
		return array( 'product' => self::product_summary( wc_get_product( $id ) ), 'updated' => true );
	}

	private static function set_stock( $data ) {
		$p = self::find_product( $data );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		if ( ! array_key_exists( 'quantity', $data ) ) {
			return new WP_Error( 'bad_request', 'Pass a quantity.', array( 'status' => 400 ) );
		}
		$qty = (int) $data['quantity'];
		$p->set_manage_stock( true );
		$p->set_stock_quantity( $qty );
		$p->set_stock_status( $qty > 0 ? 'instock' : 'outofstock' );
		$p->save();
		return array( 'product' => self::product_summary( $p ) );
	}

	/** Trash a product (reversible from wp-admin). data.force === true deletes
	 *  it permanently instead — use sparingly. */
	private static function delete_product( $data ) {
		$p = self::find_product( $data );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		$id    = $p->get_id();
		$name  = $p->get_name();
		$force = ! empty( $data['force'] );
		$ok    = $p->delete( $force );
		if ( ! $ok ) {
			return new WP_Error( 'delete_failed', 'WooCommerce could not remove the product.', array( 'status' => 500 ) );
		}
		return array( 'deleted' => true, 'id' => $id, 'name' => $name, 'permanent' => $force );
	}

	private static function create_post( $data ) {
		if ( empty( $data['title'] ) ) {
			return new WP_Error( 'bad_request', 'A title is required.', array( 'status' => 400 ) );
		}
		$status = ( isset( $data['status'] ) && in_array( $data['status'], array( 'draft', 'publish', 'pending', 'private' ), true ) )
			? $data['status'] : 'draft';
		$post_id = wp_insert_post( array(
			'post_type'    => 'post',
			'post_title'   => sanitize_text_field( $data['title'] ),
			'post_content' => isset( $data['content'] ) ? wp_kses_post( $data['content'] ) : '',
			'post_excerpt' => isset( $data['excerpt'] ) ? sanitize_text_field( $data['excerpt'] ) : '',
			'post_status'  => $status,
		), true );
		if ( is_wp_error( $post_id ) ) {
			return $post_id;
		}
		if ( ! empty( $data['categories'] ) ) {
			wp_set_post_categories( $post_id, self::term_ids( 'category', $data['categories'] ) );
		}
		$img = self::sideload_images( isset( $data['featured_image'] ) ? array( $data['featured_image'] ) : array(), $post_id );
		if ( $img ) {
			set_post_thumbnail( $post_id, $img[0] );
		}
		return array( 'post' => array(
			'id'        => $post_id,
			'status'    => get_post_status( $post_id ),
			'permalink' => get_permalink( $post_id ),
			'edit_url'  => admin_url( 'post.php?post=' . $post_id . '&action=edit' ),
		), 'created' => true );
	}

	// ── pages — plain WordPress content, no WooCommerce required ────────────

	private static function page_summary( $post ) {
		return array(
			'id'        => $post->ID,
			'title'     => $post->post_title,
			'slug'      => $post->post_name,
			'status'    => $post->post_status,
			'modified'  => $post->post_modified,
			'permalink' => get_permalink( $post->ID ),
			'edit_url'  => admin_url( 'post.php?post=' . $post->ID . '&action=edit' ),
		);
	}

	private static function find_page( $data ) {
		if ( empty( $data['id'] ) ) {
			return new WP_Error( 'bad_request', 'Pass a page id.', array( 'status' => 400 ) );
		}
		$post = get_post( (int) $data['id'] );
		if ( ! $post || 'page' !== $post->post_type ) {
			return new WP_Error( 'not_found', 'No page with that id.', array( 'status' => 404 ) );
		}
		return $post;
	}

	private static function list_pages( $data ) {
		$q = new WP_Query( array(
			'post_type'      => 'page',
			'post_status'    => isset( $data['status'] ) ? sanitize_key( $data['status'] ) : array( 'publish', 'draft', 'pending', 'private' ),
			'posts_per_page' => min( 50, max( 1, (int) ( $data['limit'] ?? 30 ) ) ),
			'orderby'        => 'title',
			'order'          => 'ASC',
			's'              => isset( $data['search'] ) ? sanitize_text_field( $data['search'] ) : '',
		) );
		$out = array();
		foreach ( $q->posts as $post ) {
			$out[] = self::page_summary( $post );
		}
		return array( 'pages' => $out, 'total' => (int) $q->found_posts );
	}

	// Named get_page_action (not get_page) — get_page() is a WP core function
	// and this stays a plain private method on the class, but avoiding the
	// name keeps a search for "get_page" pointing at the real one.
	private static function get_page_action( $data ) {
		$post = self::find_page( $data );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		return array( 'page' => array_merge( self::page_summary( $post ), self::seo_meta( $post->ID ), array(
			'content' => $post->post_content,
			'excerpt' => $post->post_excerpt,
		) ) );
	}

	private static function create_page( $data ) {
		if ( empty( $data['title'] ) ) {
			return new WP_Error( 'bad_request', 'A page title is required.', array( 'status' => 400 ) );
		}
		$status = ( isset( $data['status'] ) && in_array( $data['status'], array( 'draft', 'publish', 'pending', 'private' ), true ) )
			? $data['status'] : 'draft'; // never auto-publish
		$id = wp_insert_post( array(
			'post_type'    => 'page',
			'post_title'   => sanitize_text_field( $data['title'] ),
			'post_content' => isset( $data['content'] ) ? wp_kses_post( $data['content'] ) : '',
			'post_excerpt' => isset( $data['excerpt'] ) ? sanitize_text_field( $data['excerpt'] ) : '',
			'post_status'  => $status,
		), true );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		self::set_seo_meta( $id, $data );
		return array( 'page' => self::page_summary( get_post( $id ) ), 'created' => true );
	}

	private static function update_page( $data ) {
		$post = self::find_page( $data );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$update = array( 'ID' => $post->ID );
		if ( isset( $data['title'] ) )              { $update['post_title'] = sanitize_text_field( $data['title'] ); }
		if ( isset( $data['content'] ) )             { $update['post_content'] = wp_kses_post( $data['content'] ); }
		if ( isset( $data['excerpt'] ) )             { $update['post_excerpt'] = sanitize_text_field( $data['excerpt'] ); }
		if ( isset( $data['status'] ) && in_array( $data['status'], array( 'draft', 'publish', 'pending', 'private' ), true ) ) {
			$update['post_status'] = $data['status'];
		}
		$id = wp_update_post( $update, true );
		if ( is_wp_error( $id ) ) {
			return $id;
		}
		self::set_seo_meta( $id, $data );
		return array( 'page' => self::page_summary( get_post( $id ) ), 'updated' => true );
	}

	/** Trash a page (reversible from wp-admin). data.force === true deletes
	 *  it permanently instead — use sparingly. */
	private static function delete_page( $data ) {
		$post = self::find_page( $data );
		if ( is_wp_error( $post ) ) {
			return $post;
		}
		$force  = ! empty( $data['force'] );
		$id     = $post->ID;
		$title  = $post->post_title;
		$result = wp_delete_post( $id, $force );
		if ( ! $result ) {
			return new WP_Error( 'delete_failed', 'WordPress could not remove the page.', array( 'status' => 500 ) );
		}
		return array( 'deleted' => true, 'id' => $id, 'title' => $title, 'permanent' => $force );
	}
}
